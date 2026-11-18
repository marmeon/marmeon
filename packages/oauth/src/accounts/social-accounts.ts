import { Auth, AuthConfig, Registered, TwoFactorState, UserProvider, type AuthUser, type AuthUserId } from '@marmeon/auth';
import { CONFIRM_REAUTHENTICATED, idOf, type Reauthenticator } from '@marmeon/auth/internal';
import { err, EventDispatcher, ok, type Clock, type Logger, type Result } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { Connections } from '@marmeon/database';
import { OAuthSetupError } from '../config.ts';
import type { SocialUser } from '../definition.ts';
import { REAUTH_EARLY } from '../callback.ts';
import { FLOW_SECONDS } from '../flow.ts';
import { isOidc } from '../oidc-marker.ts';
import { OAuthProviders } from '../registry.ts';
import { consumeVerified, verifiedInfo, type VerifiedInfo } from '../verified.ts';
import { SocialAccountsConfig } from './config.ts';
import { SocialAccountLinked, SocialAccountUnlinked } from './events.ts';
import { SocialAccountStore, type SocialAccountRecord } from './store.ts';
import { SocialUserProvider } from './users.ts';

/** What a sign-in with a provider account came to. See docs/oauth.md#signing-users-in. */
export type SocialSignIn =
  | { readonly kind: 'signed-in'; readonly user: AuthUser; readonly created: boolean }
  | { readonly kind: 'two-factor-required' };

/** Why a sign-in with a provider account was refused. See docs/oauth.md#signing-users-in. */
export type SocialSignInError =
  | { readonly kind: 'signed-in' }
  | { readonly kind: 'account-exists'; readonly providerVerified: boolean }
  | { readonly kind: 'registration-closed' }
  | { readonly kind: 'email-required' }
  | { readonly kind: 'email-unverified' }
  | { readonly kind: 'invalid-account' };

/** Why a provider account was not linked. See docs/oauth.md#linking-and-unlinking. */
export type SocialLinkError =
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'confirmation-required' }
  | { readonly kind: 'email-unconfirmed' }
  | { readonly kind: 'invalid-account' }
  | { readonly kind: 'taken' }
  | { readonly kind: 'provider-linked' };

/** Why a provider account was not unlinked. See docs/oauth.md#linking-and-unlinking. */
export type SocialUnlinkError = { readonly kind: 'signed-out' } | { readonly kind: 'confirmation-required' } | { readonly kind: 'not-found' } | { readonly kind: 'last-method' };

/**
 * Why a confirmation with a provider opened no window. `signed-out`: nobody is signed in. `not-reauthenticated`: the result carries no
 * fresh sign-in at the provider. `not-linked`: the provider account is not linked to the signed-in user, or the flow was another user's.
 * `expired`: the guard refused the proof (a confirmation as recent or more recent is held already, the sign-in at the provider lies before this session's sign-in, the proof waited too long, or the request cannot write the session).
 * See docs/oauth.md#confirming-with-a-provider.
 */
export type SocialConfirmError = { readonly kind: 'signed-out' } | { readonly kind: 'not-reauthenticated' } | { readonly kind: 'not-linked' } | { readonly kind: 'expired' };

/** A linked account as a settings page shows it. See docs/oauth.md#linking-and-unlinking. */
export interface SocialAccountSummary {
  readonly provider: string;
  /** The provider's label, or its name when the provider is not active (any more). */
  readonly label: string;
  readonly email: string | null;
  readonly nickname: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  /** Whether this provider can be offered for a confirmation: it is active and an `oidc()` provider. One that sends no `auth_time` still fails. See docs/oauth.md#opening-the-confirmation-window. */
  readonly canConfirm: boolean;
}

/** The longest provider id the table holds; the store throws for a longer one, and a sign-in is refused before it gets there. */
const ID_MAX = 255;
/** The longest address of the RFC 5321 path. */
const EMAIL_MAX = 254;
/** What the callback may take between reading the clock and handing the result over: token exchange, profile request, a slow node. */
const CALLBACK_RUNTIME_MS = 30_000;
/**
 * How old a fresh sign-in at the provider may be when it is taken: the callback accepts an `auth_time` from `REAUTH_EARLY` seconds before
 * the redirect, the flow lives `FLOW_SECONDS`, and the callback itself needs some time. Anything older never came out of a flow.
 */
const REAUTH_MAX_AGE_MS = (FLOW_SECONDS + REAUTH_EARLY) * 1000 + CALLBACK_RUNTIME_MS;

/**
 * Whether the provider's data can be stored and identifies somebody. The id is not empty, not only white space, at most 255 characters,
 * well formed UTF-16 (a lone surrogate would be stored as another text) and has no control character. The address, when there is one,
 * is at most 254 characters, well formed and without control characters (a line break in it is a header injection in the first mail
 * that quotes it). The nickname is well formed and has no NUL (Postgres refuses it). Anything else is refused as a result, never a
 * 500: the data came from a provider.
 */
function storable(social: SocialUser, subject: VerifiedInfo['subject']): boolean {
  const { id, email } = subject;
  if (typeof id !== 'string' || id.trim() === '' || id.length > ID_MAX || !id.isWellFormed() || /\p{Cc}/u.test(id)) return false;
  if (email !== null && (typeof email !== 'string' || email.length > EMAIL_MAX || !email.isWellFormed() || /\p{Cc}/u.test(email))) return false;
  const { nickname } = social;
  return nickname === null || (typeof nickname === 'string' && nickname.isWellFormed() && !nickname.includes('\0'));
}

/**
 * The profile as one plain object, each field read once: the identity from what the flow recorded, the rest from the object once. An
 * accessor on the object the caller holds cannot answer one thing to the checks and another to the store. The tokens are copied the same way.
 */
function snapshotOf(given: SocialUser, subject: VerifiedInfo['subject']): SocialUser {
  const { name, nickname, avatar, raw, tokens } = given;
  const { accessToken, refreshToken, expiresAt, scopes } = tokens;
  return {
    provider: subject.provider,
    id: subject.id,
    email: subject.email,
    emailVerified: subject.emailVerified === true,
    name,
    nickname,
    avatar,
    raw,
    tokens: { accessToken, ...(refreshToken === undefined ? {} : { refreshToken }), ...(expiresAt === undefined ? {} : { expiresAt }), scopes: [...scopes] },
  };
}

/**
 * Signs people in with provider accounts, registers them, and links and unlinks accounts of the signed-in user. It accepts only a
 * `SocialUser` that `OAuth.callback()` returned, for the intent of the call: a flow that signs in cannot link, and the other way round.
 * Everything it knows about the provider account — provider, id, address, whether the provider verified it — it takes from what the
 * flow recorded, never from the object it was handed. It never makes a user itself: {@link SocialUserProvider} does.
 * See docs/oauth.md#signing-users-in.
 */
export class SocialAccounts {
  readonly #auth: Auth;
  readonly #users: UserProvider;
  readonly #factors: TwoFactorState;
  readonly #store: SocialAccountStore;
  readonly #providers: OAuthProviders;
  readonly #config: SocialAccountsConfig;
  readonly #authConfig: AuthConfig;
  readonly #connections: Connections;
  readonly #events: EventDispatcher;
  readonly #socialUsersOf: () => SocialUserProvider | undefined;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #reauthenticator: Reauthenticator;

  /** @internal Built by `SocialAccountsServiceProvider`; `socialUsers` answers the app's {@link SocialUserProvider} when it is first needed, `undefined` when none is bound. */
  constructor(
    auth: Auth,
    users: UserProvider,
    factors: TwoFactorState,
    store: SocialAccountStore,
    providers: OAuthProviders,
    config: SocialAccountsConfig,
    authConfig: AuthConfig,
    connections: Connections,
    events: EventDispatcher,
    socialUsers: () => SocialUserProvider | undefined,
    clock: Clock,
    logger: Logger,
    reauthenticator: Reauthenticator,
  ) {
    this.#auth = auth;
    this.#users = users;
    this.#factors = factors;
    this.#store = store;
    this.#providers = providers;
    this.#config = config;
    this.#authConfig = authConfig;
    this.#connections = connections;
    this.#events = events;
    this.#socialUsersOf = socialUsers;
    this.#clock = clock;
    this.#logger = logger;
    this.#reauthenticator = reauthenticator;
  }

  /**
   * Signs in with the provider account `social` came from: its owner when it is linked (the account decides, never the address), a user
   * whose address it proves (both addresses verified, no second factor — otherwise `account-exists`), or a new user when registration
   * is open. Needs the result of a flow that began as a sign-in, else throws a `TypeError`. Throws an `OAuthSetupError` (A10) when a
   * user is to be found or made and the app bound no {@link SocialUserProvider}. See docs/oauth.md#signing-users-in.
   */
  async signIn(given: SocialUser): Promise<Result<SocialSignIn, SocialSignInError>> {
    const info = verifiedInfo(given);
    if (info?.intent !== 'sign-in') throw new TypeError('SocialAccounts.signIn() needs the SocialUser that OAuth.callback() returned for a flow that began as a sign-in.');
    // Before any account is looked up: somebody who is in already has nothing to sign in as.
    if (await this.#auth.check()) return err({ kind: 'signed-in' });
    const { subject } = info;
    const social = snapshotOf(given, subject);
    if (!storable(social, subject)) return err({ kind: 'invalid-account' });
    // Only an address the provider vouched for with exactly `true` counts as verified; the rest of this method reads this, never the field.
    const providerVerified = subject.emailVerified === true;

    // Rule 1: a linked account signs in its owner.
    const known = await this.#store.find(subject.provider, subject.id);
    if (known !== undefined) return this.#enter(known, social, providerVerified);

    if (subject.email === null) return err({ kind: 'email-required' });

    // With private registration an address the provider did not verify gets one answer, whether or not an account has it: nothing is
    // looked up, made or linked, so the answer tells nothing about the accounts and a second try signs nobody in.
    if (this.#authConfig.privateRegistration && !providerVerified) return err({ kind: 'email-unverified' });

    // Rule 2: an address that exists signs in only when both sides vouch for it and no second factor stands in the way.
    const local = await this.#socialUsers().findByEmail(subject.email);
    if (local !== undefined && local !== null) return this.#linkExisting(local, social, subject, providerVerified);

    // Rule 3: a new user.
    return this.#register(social, subject, providerVerified);
  }

  /**
   * Links the provider account `social` came from to the signed-in user. Needs the result of a flow that began as a link for this very
   * user (else a `TypeError`: another user's flow is a programming error here, unlike in `confirm()`), a recent confirmation of the user (`confirmation-required`: the middleware is not what guards it) and an
   * address of the user that the app has confirmed (`email-unconfirmed`, asked of {@link SocialUserProvider.emailConfirmed}).
   * An account that belongs to another user is `taken` and never moves; a second account at one provider is `provider-linked`.
   * See docs/oauth.md#linking-and-unlinking.
   */
  async link(given: SocialUser): Promise<Result<SocialAccountSummary, SocialLinkError>> {
    const info = verifiedInfo(given);
    if (info?.intent !== 'link') throw new TypeError('SocialAccounts.link() needs the SocialUser that OAuth.callback() returned for a flow that began as a link.');
    const user = await this.#auth.user();
    const userId = await this.#auth.id();
    if (user === undefined || userId === undefined) return err({ kind: 'signed-out' });
    // The flow was begun by this user: a result another user's flow made does not link here.
    if (info.flowUserId !== String(userId)) throw new TypeError('SocialAccounts.link() was given the result of a flow that another user began.');
    if (!this.#auth.passwordRecentlyConfirmed()) return err({ kind: 'confirmation-required' });
    const { subject } = info;
    const social = snapshotOf(given, subject);
    // An account with an unconfirmed address is the one a password reset strips of every link: a link made now would be one a squatter could add.
    if ((await this.#socialUsers().emailConfirmed(user)) !== true) return err({ kind: 'email-unconfirmed' });
    if (!storable(social, subject)) return err({ kind: 'invalid-account' });

    const held = await this.#store.find(subject.provider, subject.id);
    if (held !== undefined) {
      // The same user again is no new link; any other owner keeps it.
      if (String(held.userId) !== String(userId)) return err({ kind: 'taken' });
      if (!(await this.#store.touch(held.id, social))) return err({ kind: 'taken' });
      return ok(this.#summary((await this.#store.find(subject.provider, subject.id)) ?? held));
    }
    const created = await this.#store.create(userId, social);
    if (!created.ok) return err(created.error);
    await this.#events.dispatch(new SocialAccountLinked(user, subject.provider, subject.email, social.nickname));
    return ok(this.#summary(created.value));
  }

  /**
   * Unlinks the signed-in user's account at `provider`. Needs a recent confirmation of the user, and another way in: a password, a
   * passkey or an account at a provider that is active. See docs/oauth.md#linking-and-unlinking.
   */
  async unlink(provider: string): Promise<Result<void, SocialUnlinkError>> {
    const user = await this.#auth.user();
    const userId = await this.#auth.id();
    if (user === undefined || userId === undefined) return err({ kind: 'signed-out' });
    if (!this.#auth.passwordRecentlyConfirmed()) return err({ kind: 'confirmation-required' });
    const removed = await this.#store.remove(userId, provider, (remaining) => this.#hasOtherWay(userId, remaining));
    if (!removed.ok) return err(removed.error);
    await this.#events.dispatch(new SocialAccountUnlinked(user, removed.value.provider));
    return ok(undefined);
  }

  /**
   * The id of the signed-in user's account at `provider`, which `OAuth.redirect()` takes as `account` for a confirmation; `undefined`
   * when nobody is signed in or nothing is linked there. See docs/oauth.md#confirming-with-a-provider.
   */
  async accountId(provider: string): Promise<string | undefined> {
    const userId = await this.#auth.id();
    if (userId === undefined) return undefined;
    return (await this.#store.forUser(userId)).find((record) => record.provider === provider)?.providerId;
  }

  /**
   * Opens the confirmation window of the signed-in user, counted from the time they signed in again at the provider: the same window a
   * password opens, so `link()` and `unlink()` accept it. Needs the result of a flow that began as a confirmation of this user, and a
   * provider account that is linked to them: the account is looked up here and never taken from the flow. Throws a `TypeError` for a
   * result that did not come from a confirmation flow or was spent already; another user's flow or an unlinked account answers
   * `not-linked`. Every answer, a refusal too, spends the result: the person confirms again. Unlike `link()`, which throws for another
   * user's flow (a programming error there), this answers `not-linked`, since a returning tab or a second sign-in in the browser shows
   * the same thing in a working app. See docs/oauth.md#opening-the-confirmation-window.
   */
  async confirm(given: SocialUser): Promise<Result<void, SocialConfirmError>> {
    if (verifiedInfo(given)?.intent !== 'confirm') throw new TypeError('SocialAccounts.confirm() needs the SocialUser that OAuth.callback() returned for a flow that began as a confirmation.');
    // Spent before anything else is checked, whatever follows: a result that failed one check is not kept for another try.
    const info = consumeVerified(given)!;
    const userId = await this.#auth.id();
    if (userId === undefined) return err({ kind: 'signed-out' });
    if (info.flowUserId !== String(userId)) return err({ kind: 'not-linked' });
    // Checked here again, on the accepting side: the callback records a fresh sign-in, and this is what the window is opened for.
    const at = info.reauthenticatedAt;
    if (typeof at !== 'number' || !Number.isFinite(at)) return err({ kind: 'not-reauthenticated' });
    const age = this.#clock.now() - at;
    if (!(age >= 0 && age <= REAUTH_MAX_AGE_MS)) return err({ kind: 'not-reauthenticated' });
    // The account must be linked to this user: a foreign, an unlinked and another user's provider account open nothing.
    const { subject } = info;
    // A lone surrogate would be looked up as another text, and the match below is exact: the account that is found is the one named.
    if (typeof subject.id !== 'string' || !subject.id.isWellFormed()) return err({ kind: 'not-linked' });
    const held = await this.#store.find(subject.provider, subject.id);
    if (held === undefined || held.provider !== subject.provider || held.providerId !== subject.id || String(held.userId) !== String(userId)) return err({ kind: 'not-linked' });
    const proof = this.#reauthenticator.issue({ userId, authenticatedAt: new Date(at) });
    if (!(await this.#auth[CONFIRM_REAUTHENTICATED](proof))) return err({ kind: 'expired' });
    // Only after the window is open; what the provider reports now is stored when it can be.
    const social = snapshotOf(given, subject);
    if (storable(social, subject)) {
      try {
        await this.#store.touch(held.id, social);
      } catch {
        // The window is open and stays so; a failed refresh of what the provider reports is no reason to refuse. Nothing of the error is logged: it may quote data.
        this.#logger.warn('Refreshing a linked provider account after a confirmation failed.', { provider: subject.provider, reason: 'touch' });
      }
    }
    return ok(undefined);
  }

  /** The signed-in user's linked accounts, oldest first; none for nobody. See docs/oauth.md#linking-and-unlinking. */
  async list(): Promise<readonly SocialAccountSummary[]> {
    const userId = await this.#auth.id();
    if (userId === undefined) return [];
    return (await this.#store.forUser(userId)).map((record) => this.#summary(record));
  }

  #summary(record: SocialAccountRecord): SocialAccountSummary {
    return {
      provider: record.provider,
      label: this.#providers.get(record.provider)?.label ?? record.provider,
      email: record.email,
      nickname: record.nickname,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      canConfirm: isOidc(this.#providers.get(record.provider)?.definition),
    };
  }

  /** Whether the user could still sign in after the account was deleted: an account at an active provider, a password, or a passkey. Without a bound `TwoFactorState` no passkey counts. */
  async #hasOtherWay(userId: AuthUserId, remaining: readonly SocialAccountRecord[]): Promise<boolean> {
    if (remaining.some((record) => this.#providers.get(record.provider) !== undefined)) return true;
    const credentials = await this.#users.findById(userId as never);
    if (credentials !== undefined && credentials.passwordHash !== null) return true;
    return (await this.#factors.factors(userId)).includes('passkey');
  }

  /** Rule 1: signs in the owner of the linked account `known`. A provider account whose user or row is gone is refused. */
  async #enter(known: SocialAccountRecord, social: SocialUser, providerVerified: boolean): Promise<Result<SocialSignIn, SocialSignInError>> {
    const credentials = await this.#users.findById(known.userId as never);
    const refused = err({ kind: 'account-exists' as const, providerVerified });
    if (credentials === undefined) return refused;
    // Before the user is let in: an account unlinked since it was found does not sign in.
    if (!(await this.#store.touch(known.id, social))) return refused;
    const outcome = await this.#auth.signIn(credentials.user);
    // Looked up once more now that the sign-in ran, whatever it came to: the account may have been unlinked, or moved, since `touch`. A
    // sign-in for a link that is gone is undone, a waiting second factor included (`signOut()` drops a pending sign-in too).
    const still = await this.#store.find(known.provider, known.providerId);
    if (still === undefined || still.id !== known.id || String(still.userId) !== String(known.userId)) {
      await this.#auth.signOut();
      return refused;
    }
    if (outcome !== 'signed-in') return ok({ kind: 'two-factor-required' });
    return ok({ kind: 'signed-in', user: credentials.user, created: false });
  }

  /** Rule 2, strict: links the account to the user who has the address, only when both addresses are verified and the user has no second factor. */
  async #linkExisting(local: { readonly user: AuthUser; readonly emailVerified: boolean }, social: SocialUser, subject: VerifiedInfo['subject'], providerVerified: boolean): Promise<Result<SocialSignIn, SocialSignInError>> {
    const refused = err({ kind: 'account-exists' as const, providerVerified });
    const userId = idOf(local.user);
    // Both sides must vouch for the address, and a user with a second factor never signs in around it: they sign in first, then link.
    if (!providerVerified || local.emailVerified !== true) return refused;
    if ((await this.#factors.factors(userId)).length > 0) return refused;
    const linked = await this.#store.create(userId, social);
    if (!linked.ok) {
      if (linked.error.kind === 'provider-linked') return refused;
      // The account was linked between the lookup and the insert: asked again once, it is rule 1.
      const known = await this.#store.find(subject.provider, subject.id);
      return known === undefined ? refused : this.#enter(known, social, providerVerified);
    }
    await this.#events.dispatch(new SocialAccountLinked(local.user, subject.provider, subject.email, social.nickname));
    const outcome = await this.#auth.signIn(local.user);
    return ok(outcome === 'signed-in' ? { kind: 'signed-in', user: local.user, created: false } : { kind: 'two-factor-required' });
  }

  /** Rule 3: the user and the link in one transaction. An address taken in the meantime rolls the user back. */
  async #register(social: SocialUser, subject: VerifiedInfo['subject'], providerVerified: boolean): Promise<Result<SocialSignIn, SocialSignInError>> {
    if (!this.#config.registration) return err({ kind: 'registration-closed' });
    const created = await this.#connections.transaction(async () => {
      const made = await this.#socialUsers().create(social as SocialUser & { readonly email: string }, { emailVerified: providerVerified });
      if (!made.ok) return err({ kind: 'account-exists' as const, providerVerified });
      const userId = idOf(made.value);
      const linked = await this.#store.create(userId, social);
      // An err rolls the new user back; the account was taken by another sign-in in the meantime.
      if (!linked.ok) return err({ kind: 'account-exists' as const, providerVerified });
      // As the registration of the app does, in the same transaction: the verification mail listens to it.
      await this.#events.dispatch(new Registered(made.value));
      return ok(made.value);
    });
    if (!created.ok) return err(created.error);
    const user = created.value;
    await this.#events.dispatch(new SocialAccountLinked(user, subject.provider, subject.email, social.nickname));
    const outcome = await this.#auth.signIn(user);
    return ok(outcome === 'signed-in' ? { kind: 'signed-in', user, created: true } : { kind: 'two-factor-required' });
  }

  /** The app's `SocialUserProvider`, asked for when a user is looked up, made or checked. One that is bound but cannot be built throws its own error. */
  #socialUsers(): SocialUserProvider {
    const provider = this.#socialUsersOf();
    if (provider === undefined) {
      throw new OAuthSetupError(withCode('A10', 'SocialUserProvider is not bound: signing in and linking with a provider need the app to say how users are found and made — container.bind(SocialUserProvider, …). See docs/oauth.md#signing-users-in.'));
    }
    return provider;
  }
}

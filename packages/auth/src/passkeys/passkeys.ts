import { RateLimiter } from '@marmeon/cache';
import { Clock, err, EventDispatcher, Logger, ok, type Result } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { RequestInfo } from '@marmeon/http';
import { CookieJar } from '@marmeon/router';
import { Session } from '@marmeon/session';
import { Auth, AUTH_SESSION_KEYS, READ_PENDING, SIGN_IN_VERIFIED, SIGN_OUT_OTHER_DEVICES } from '../auth.ts';
import { AuthConfig } from '../config.ts';
import { PasskeyCloneSuspected, PasskeyRegistered, PasskeyRemoved, RecoveryCodesGenerated, TwoFactorDisabled, TwoFactorEnabled } from '../events.ts';
import { RememberTokenStore } from '../remember.ts';
import { generateRecoveryCodes, hashRecoveryCode } from '../two-factor/recovery-codes.ts';
import { NoTwoFactorState, SecondFactorPasskeys, TwoFactorState, type PasskeyAssertion } from '../two-factor/state.ts';
import { TwoFactorStore } from '../two-factor/store.ts';
import { idOf, UserProvider, type AuthUser } from '../user.ts';
import { issueChallenge, takeChallenge, type ChallengePurpose } from './challenge.ts';
import { PasskeyConfig } from './config.ts';
import { PasskeyStore, type PasskeyRecord } from './store.ts';
import {
  authenticationOptions,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from './webauthn.ts';

/** Password checks per account, shared by `register()` and `remove()`: five a minute and twenty an hour; a success clears the minute. */
const PASSWORD_WINDOWS = [
  { name: 'minute', attempts: 5, seconds: 60 },
  { name: 'hour', attempts: 20, seconds: 3600 },
] as const;

/** Passwordless attempts per address and minute. A bad response cannot be guessed, so this limits load, not guessing. */
const SIGN_IN_WINDOW = { attempts: 10, seconds: 60 } as const;
const MAX_NAME_LENGTH = 100;

/** Why a passkey ceremony did not count. `clone-suspected`: the passkey's counter did not move forward, it may have been copied. */
export type PasskeyError =
  | { readonly kind: 'no-challenge' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'clone-suspected' }
  | { readonly kind: 'throttled'; readonly retryAfter: number };

/** Why `register()` did not add the passkey. */
export type RegisterError =
  | { readonly kind: 'no-challenge' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'invalid-password' }
  | { readonly kind: 'throttled'; readonly retryAfter: number }
  | { readonly kind: 'duplicate' };

/** What a settings page lists of a passkey. */
export interface PasskeySummary {
  readonly id: number;
  readonly name: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  /** Synchronised to the user's other devices (the backup flag the authenticator reported). */
  readonly synced: boolean;
}

/**
 * Passkeys for the current request: register them, sign in without a password, and prove one as the second factor of a sign-in. See
 * `docs/passkeys.md`.
 *
 * Invariants: a challenge works once and only for its purpose (it leaves the session before anything is checked); user verification is
 * required everywhere; RP ID and origins come from configuration; a passkey signs in only its own account; a sign count that does not
 * move forward refuses the sign-in and is never written; the first passkey is a factor like an authenticator app and ends the other
 * devices' sessions. Every failure refuses.
 */
export class Passkeys implements SecondFactorPasskeys {
  readonly #auth: Auth;
  readonly #session: Session;
  readonly #store: PasskeyStore;
  readonly #twoFactorStore: TwoFactorStore;
  readonly #state: TwoFactorState;
  readonly #config: PasskeyConfig;
  readonly #authConfig: AuthConfig;
  readonly #connections: Connections;
  readonly #remember: RememberTokenStore;
  readonly #limiter: RateLimiter;
  readonly #events: EventDispatcher;
  readonly #request: RequestInfo;
  readonly #users: UserProvider;
  readonly #cookies: CookieJar;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(
    auth: Auth,
    session: Session,
    store: PasskeyStore,
    twoFactorStore: TwoFactorStore,
    state: TwoFactorState,
    config: PasskeyConfig,
    authConfig: AuthConfig,
    connections: Connections,
    remember: RememberTokenStore,
    limiter: RateLimiter,
    events: EventDispatcher,
    request: RequestInfo,
    users: UserProvider,
    cookies: CookieJar,
    clock: Clock,
    logger: Logger,
  ) {
    this.#auth = auth;
    this.#session = session;
    this.#store = store;
    this.#twoFactorStore = twoFactorStore;
    this.#state = state;
    this.#config = config;
    this.#authConfig = authConfig;
    this.#connections = connections;
    this.#remember = remember;
    this.#limiter = limiter;
    this.#events = events;
    this.#request = request;
    this.#users = users;
    this.#cookies = cookies;
    this.#clock = clock;
    this.#logger = logger;
  }

  // -- Registration ----------------------------------------------------------------------------------------------------------

  /**
   * The options for `navigator.credentials.create()`. Needs a signed-in user who typed the password recently (`confirmedPassword()`);
   * opens the one challenge of this session, for registering. The user handle in the options is kept with the challenge, and
   * `register()` stores the passkey with that very handle.
   */
  async registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const user = await this.#requireRecentPassword('registrationOptions');
    // Without a bound source of factors a registered passkey would never be asked for at sign-in: fail closed before anything is made.
    if (this.#state instanceof NoTwoFactorState) throw new Error('Passkeys need a source of factors: bind TwoFactorState to combineFactors(TwoFactorStore, PasskeyStore) in a provider of your auth module.');
    const id = idOf(user);
    const relyingParty = this.#config.relyingParty();
    const userHandle = await this.#store.userHandle(id);
    const { bytes } = issueChallenge(this.#session, 'register', this.#now(), id, userHandle);
    const account = user as { email?: unknown; name?: unknown };
    const email = typeof account.email === 'string' ? account.email : String(id);
    return registrationOptions({
      ...relyingParty,
      rpName: this.#authConfig.appName ?? relyingParty.rpId,
      userHandle: Buffer.from(userHandle, 'base64url'),
      userName: email,
      userDisplayName: typeof account.name === 'string' ? account.name : email,
      challenge: bytes,
      existing: (await this.#store.forUser(id)).map((passkey) => ({ credentialId: passkey.credentialId, transports: passkey.transports })),
    });
  }

  /**
   * Adds the passkey the browser made. Needs a signed-in user who typed the password recently, and the password again in the same form —
   * for every passkey, not only the first: a passkey outlives a password change, so a stolen session in the sudo window must not be able to add one.
   * The password check is throttled per account (five a minute, twenty an hour). When it is the account's first factor, the other
   * devices are signed out — sessions and remember-me tokens, a second time after the insert, as `TwoFactor.confirm()` does — and the
   * account gets recovery codes, shown now and never again. `recoveryCodes` is `null` for a later passkey.
   *
   * Order: the challenge leaves the session, the throttle counts, the password is checked, the response is verified, the other devices
   * are signed out, and the passkey and the recovery codes are stored in one transaction.
   */
  async register(response: RegistrationResponseJSON, name: string, password?: string): Promise<Result<{ recoveryCodes: readonly string[] | null }, RegisterError>> {
    const user = await this.#requireRecentPassword('register');
    const id = idOf(user);
    // First of all, so that this challenge is spent whatever happens next.
    const taken = takeChallenge(this.#session, 'register', this.#now(), id);
    if (!taken.ok) return err(taken.error);
    const handle = taken.value.userHandle;
    if (handle === undefined) return err({ kind: 'invalid' });

    const first = (await this.#state.factors(id)).length === 0;
    // Turning the first factor on signs the other devices out, which hashes the password anew.
    if (first && ((await this.#users.findById(id as never))?.passwordHash ?? null) === null) throw new Error('passkeys.register() needs an account with a password for its first factor: turning it on signs out the other devices with it.');
    const checked = await this.#checkPassword(id, password);
    if (!checked.ok) return err(checked.error);

    const verified = await verifyRegistration(response, { ...this.#config.relyingParty(), challenge: taken.value.challenge }, this.#logger);
    if (!verified.ok) return err({ kind: 'invalid' });
    const cleanName = cleanedName(name);
    const recoveryCodes = first ? generateRecoveryCodes() : null;

    // Before the factor exists, so that a failure after this point leaves it off and the other devices out — never the factor on and an old session alive.
    if (first) await this.#auth[SIGN_OUT_OTHER_DEVICES](password!);
    const created = await this.#connections.transaction(async () => {
      const result = await this.#store.create({ userId: id, userHandle: handle, name: cleanName, ...verified.value });
      if (result.ok && recoveryCodes !== null) await this.#twoFactorStore.replaceRecoveryCodes(id, recoveryCodes.map((code) => hashRecoveryCode(id, code)));
      return result; // an err rolls the transaction back
    });
    if (!created.ok) return err({ kind: 'duplicate' });

    if (first) {
      // Once more, now that the factor is committed: a session or token made in the window since the first sign-out dies here.
      try {
        await this.#auth[SIGN_OUT_OTHER_DEVICES](password!);
        await this.#remember.forgetUser(id);
      } catch (error) {
        this.#logger.error('A passkey was registered as the first factor, but signing out the other devices a second time failed: sessions made meanwhile may be open', { user: id, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      this.#cookies.delete(this.#authConfig.rememberCookie);
    }
    // The state must see the passkey, else sign-in would never ask for it: a state bound to something else fails closed here.
    if (!(await this.#state.factors(id)).includes('passkey')) {
      await this.#store.remove(id, created.value.id, { lastFactorAllowed: true });
      throw new Error('The TwoFactorState does not report the passkey that was just registered: bind it to combineFactors(TwoFactorStore, PasskeyStore). The registration was rolled back.');
    }
    if (first) this.#session.put(AUTH_SESSION_KEYS.twoFactorAt, this.#now());
    await this.#events.dispatch(new PasskeyRegistered(user, cleanName));
    if (first) {
      await this.#events.dispatch(new TwoFactorEnabled(user, 'passkey'));
      await this.#events.dispatch(new RecoveryCodesGenerated(user));
    }
    return ok({ recoveryCodes });
  }

  // -- Signing in ------------------------------------------------------------------------------------------------------------

  /** The options for a passwordless sign-in: no list of credentials (nothing is learnt about who exists), user verification required. */
  async signInOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const { bytes } = issueChallenge(this.#session, 'sign-in', this.#now());
    return authenticationOptions({ rpId: this.#config.relyingParty().rpId, challenge: bytes });
  }

  /**
   * Signs in with a passkey alone — the verified passkey with user verification is the whole sign-in, no second factor follows. The user is
   * the passkey's own account, and the response must carry that account's user handle. `remember` keeps the device signed in.
   * The `Login` event says `via: 'passkey'`.
   */
  async signIn(response: AuthenticationResponseJSON, options: { readonly remember?: boolean } = {}): Promise<Result<AuthUser, PasskeyError>> {
    const checked = await this.#check(response, 'sign-in');
    if (!checked.ok) return checked;
    const signedIn = await this.#auth[SIGN_IN_VERIFIED](checked.value.userId, options);
    if (!signedIn.ok) return err({ kind: 'invalid' });
    // A success clears the address's count: behind one shared address (a NAT) many people sign in, and only failures are to add up.
    await this.#limiter.clear(this.#signInKey());
    return ok(signedIn.value);
  }

  /**
   * The options for proving a passkey as a second factor: only the account's own passkeys are allowed. For `'second-factor'` (the default)
   * the account is the waiting sign-in's — `no-challenge` or `expired` without a good one; for `'step-up'` it is the signed-in user's.
   */
  async challengeOptions(purpose: 'second-factor' | 'step-up' = 'second-factor'): Promise<Result<PublicKeyCredentialRequestOptionsJSON, { readonly kind: 'no-challenge' } | { readonly kind: 'expired' }>> {
    let userId: number | string;
    if (purpose === 'step-up') {
      userId = idOf(await this.#requireUser('challengeOptions'));
    } else {
      const pending = await this.#auth[READ_PENDING]();
      if (pending === undefined) return err({ kind: 'no-challenge' });
      if (pending === 'expired') return err({ kind: 'expired' });
      userId = pending.userId;
    }
    const { bytes } = issueChallenge(this.#session, purpose, this.#now(), userId);
    const allow = (await this.#store.forUser(userId)).map((passkey) => ({ credentialId: passkey.credentialId, transports: passkey.transports }));
    return ok(await authenticationOptions({ rpId: this.#config.relyingParty().rpId, challenge: bytes, allow }));
  }

  /** @internal What `TwoFactor` calls for `{ passkey }`, after it has read the pending sign-in (or the signed-in user) and counted the attempt. */
  async verify(userId: number | string, assertion: PasskeyAssertion, purpose: 'second-factor' | 'step-up' = 'second-factor'): Promise<boolean> {
    const checked = await this.#check(assertion as AuthenticationResponseJSON, purpose, userId);
    return checked.ok;
  }

  // -- Managing --------------------------------------------------------------------------------------------------------------

  /** The signed-in user's passkeys, oldest first. */
  async list(): Promise<readonly PasskeySummary[]> {
    const user = await this.#requireUser('list');
    return (await this.#store.forUser(idOf(user))).map((passkey) => ({ id: passkey.id, name: passkey.name, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt, synced: passkey.backedUp }));
  }

  /** Renames a passkey of the signed-in user (a recently typed password); `false` for an empty or too long name, or one that is not theirs. */
  async rename(id: number, name: string): Promise<boolean> {
    const user = await this.#requireRecentPassword('rename');
    const clean = name.replace(/\p{Cc}/gu, '').trim();
    if (clean === '' || [...clean].length > MAX_NAME_LENGTH) return false;
    return this.#store.rename(idOf(user), id, clean);
  }

  /**
   * Removes a passkey of the signed-in user (a recently typed password). When it is the account's last factor — no other passkey, no
   * authenticator app — `password` is required, typed now, and the recovery codes go with it, as with `TwoFactor.disable()`. The store
   * decides inside its transaction, so parallel removals cannot both pass. A password given is checked under the per-account throttle
   * of `register()` (five a minute, twenty an hour).
   */
  async remove(id: number, password?: string): Promise<Result<void, { readonly kind: 'invalid-password' } | { readonly kind: 'not-found' } | { readonly kind: 'throttled'; readonly retryAfter: number }>> {
    const user = await this.#requireRecentPassword('remove');
    const userId = idOf(user);
    let lastFactorAllowed = false;
    if (password !== undefined) {
      const checked = await this.#checkPassword(userId, password);
      if (checked.ok) lastFactorAllowed = true;
      else if (checked.error.kind === 'throttled') return err(checked.error);
    }
    const removed = await this.#store.remove(userId, id, { lastFactorAllowed });
    if (!removed.ok) return err(removed.error.kind === 'last-factor' ? { kind: 'invalid-password' } : { kind: 'not-found' });
    await this.#events.dispatch(new PasskeyRemoved(user));
    if (removed.value.lastFactor) await this.#events.dispatch(new TwoFactorDisabled(user, 'user'));
    return ok();
  }

  /** The password of the signed-in user, typed now: counted per account before it is checked, the minute cleared by a success. */
  async #checkPassword(userId: number | string, password: string | undefined): Promise<Result<void, { readonly kind: 'invalid-password' } | { readonly kind: 'throttled'; readonly retryAfter: number }>> {
    const waits: number[] = [];
    for (const window of PASSWORD_WINDOWS) {
      const key = `passkey-password-${window.name}:${userId}`;
      if (!(await this.#limiter.attempt(key, window.attempts, window.seconds))) waits.push(await this.#limiter.availableIn(key));
    }
    if (waits.length > 0) return err({ kind: 'throttled', retryAfter: Math.max(1, ...waits) });
    if (password === undefined || !(await this.#auth.confirmPassword(password))) return err({ kind: 'invalid-password' });
    await this.#limiter.clear(`passkey-password-minute:${userId}`);
    return ok();
  }

  // -- Checking a response ---------------------------------------------------------------------------------------------------

  /**
   * The one check behind a passwordless sign-in and a second factor. The challenge leaves the session first; then the passkey is found by
   * its credential id and must belong to `expectedUser` (a second factor) — a passwordless response needs its user handle instead. The sign
   * count is written only for a response that passed everything, and only if no other request moved it meanwhile.
   */
  async #check(response: AuthenticationResponseJSON, purpose: ChallengePurpose, expectedUser?: number | string): Promise<Result<PasskeyRecord, PasskeyError>> {
    const taken = takeChallenge(this.#session, purpose, this.#now(), expectedUser);
    if (!taken.ok) return err(taken.error);
    if (purpose === 'sign-in') {
      const wait = await this.#throttleSignIn();
      if (wait !== undefined) return err({ kind: 'throttled', retryAfter: wait });
    }
    const credentialId = typeof (response as { id?: unknown } | null)?.id === 'string' ? response.id : '';
    const record = credentialId === '' ? undefined : await this.#store.findByCredentialId(credentialId);
    if (record === undefined) return err({ kind: 'invalid' });
    // A passkey proves its own account only: one of another account never completes this sign-in.
    if (expectedUser !== undefined && String(record.userId) !== String(expectedUser)) return err({ kind: 'invalid' });

    const verified = await verifyAuthentication(
      response,
      { ...this.#config.relyingParty(), challenge: taken.value.challenge, discoverable: purpose === 'sign-in' },
      { credentialId: record.credentialId, publicKey: record.publicKey, signCount: record.signCount, transports: record.transports, userHandle: record.userHandle, backupEligible: record.backupEligible },
      this.#logger,
    );
    if (!verified.ok) {
      if (verified.error.kind === 'clone-suspected') {
        // The counter is not written: the stored one stays the last that was honest.
        const found = await this.#users.findById(record.userId as never);
        if (found) await this.#events.dispatch(new PasskeyCloneSuspected(found.user, record.id));
        this.#logger.warn('A passkey answered with a sign count that did not move forward: it may have been copied', { user: record.userId, passkey: record.id });
      }
      return err(verified.error);
    }
    if (!(await this.#store.updateCounter(record.id, record.signCount, verified.value.signCount, verified.value.backedUp))) return err({ kind: 'invalid' });
    return ok(record);
  }

  async #throttleSignIn(): Promise<number | undefined> {
    const key = this.#signInKey();
    return (await this.#limiter.attempt(key, SIGN_IN_WINDOW.attempts, SIGN_IN_WINDOW.seconds)) ? undefined : Math.max(1, await this.#limiter.availableIn(key));
  }

  #signInKey(): string {
    return `passkey-sign-in:${this.#request.ip ?? 'unknown'}`;
  }

  #now(): number {
    return Math.floor(this.#clock.now() / 1000);
  }

  async #requireUser(method: string): Promise<AuthUser> {
    const user = await this.#auth.user();
    if (!user) throw new Error(`passkeys.${method}() needs a signed-in user — put the route behind authenticate().`);
    return user;
  }

  async #requireRecentPassword(method: string): Promise<AuthUser> {
    const user = await this.#requireUser(method);
    if (!this.#auth.passwordRecentlyConfirmed()) throw new Error(`passkeys.${method}() needs a recently typed password — put the route behind confirmedPassword().`);
    return user;
  }
}

/** A name for the list: trimmed, control characters out, at most 100 characters; `Passkey` when nothing is left. */
function cleanedName(name: string): string {
  const clean = [...name.replace(/\p{Cc}/gu, '').trim()].slice(0, MAX_NAME_LENGTH).join('');
  return clean === '' ? 'Passkey' : clean;
}

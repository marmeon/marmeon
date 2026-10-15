import { createHash } from 'node:crypto';
import { RateLimiter } from '@marmeon/cache';
import { Clock, err, EventDispatcher, Logger, ok, type Result } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { RequestInfo } from '@marmeon/http';
import { CookieJar } from '@marmeon/router';
import { Session } from '@marmeon/session';
import { claimRefused } from '../account-sessions.ts';
import { ACCOUNT_STILL_CLAIMED, Auth, AUTH_SESSION_KEYS, CLAIM_ACCOUNT, READ_PENDING, SIGN_IN_VERIFIED, SIGN_OUT_OTHER_DEVICES } from '../auth.ts';
import { AuthConfig } from '../config.ts';
import { PasskeyCloneSuspected, PasskeyRegistered, PasskeyRemoved, PasskeySignInFailed, RecoveryCodesGenerated, TwoFactorDisabled, TwoFactorEnabled } from '../events.ts';
import { RememberTokenStore } from '../remember.ts';
import { FACTOR_CHANGE_MAX_AGE, secondFactorProvenWithin } from '../two-factor/proof.ts';
import { generateRecoveryCodes, hashRecoveryCode } from '../two-factor/recovery-codes.ts';
import { NoTwoFactorState, SecondFactorPasskeys, TwoFactorState, VERIFY_SECOND_FACTOR, type PasskeyAssertion, type PasskeyVerdict } from '../two-factor/state.ts';
import { TwoFactorStore } from '../two-factor/store.ts';
import { idOf, UserProvider, type AuthUser } from '../user.ts';
import { CHALLENGE_SECONDS, issueChallenge, takeChallenge, type ChallengePurpose } from './challenge.ts';
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

/**
 * Failed passwordless attempts per address and minute. Only failures count (behind one shared address many people sign in, and an
 * attacker must not be able to lock the owner out by sending garbage). A bad response cannot be guessed, so this limits load, not guessing.
 */
const SIGN_IN_WINDOW = { attempts: 60, seconds: 60 } as const;
const MAX_NAME_LENGTH = 100;
/** Passkeys per account: more is no use, and every one adds to what `excludeCredentials` and the list carry. */
const MAX_PASSKEYS = 20;

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
  | { readonly kind: 'limit' }
  | { readonly kind: 'duplicate' }
  /** The session ended while the passkey was being added (another device changed the password, `AccountSessions.end()`): nothing was stored. */
  | { readonly kind: 'signed-out' };

/** What a settings page lists of a passkey. */
export interface PasskeySummary {
  readonly id: number;
  readonly name: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  /** A possible clone: it signs nobody in until the password releases it. */
  readonly suspended: boolean;
  /** Synchronised to the user's other devices (the backup flag the authenticator reported). */
  readonly synced: boolean;
}

/**
 * Passkeys for the current request: register them, sign in without a password, and prove one as the second factor of a sign-in or again in a signed-in session. See
 * `docs/passkeys.md#managing-passkeys`.
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
    await this.#requireRecentSecondFactor('registrationOptions', id);
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
    // Before the challenge is taken: a session that may not add a passkey keeps the challenge it holds.
    await this.#requireRecentSecondFactor('register', id);
    // First of all, so that this challenge is spent whatever happens next.
    const taken = takeChallenge(this.#session, 'register', this.#now(), id);
    if (!taken.ok) return err(taken.error);
    if (!(await this.#spend(taken.value.challenge))) return err({ kind: 'no-challenge' });
    const handle = taken.value.userHandle;
    if (handle === undefined) return err({ kind: 'invalid' });
    if ((await this.#store.forUser(id)).length >= MAX_PASSKEYS) return err({ kind: 'limit' });

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
      // First, so the account's row is locked until the commit: a session that ended meanwhile stores no passkey.
      if (!(await this.#auth[CLAIM_ACCOUNT]())) return err({ kind: 'signed-out' } as const);
      const result = await this.#store.create({ userId: id, userHandle: handle, name: cleanName, ...verified.value });
      if (result.ok && recoveryCodes !== null) {
        await this.#twoFactorStore.replaceRecoveryCodes(id, recoveryCodes.map((code) => hashRecoveryCode(id, code)));
        // An authenticator setup begun before this first factor has no confirmed secret to protect: left over, it could later be confirmed as a further factor.
        await this.#twoFactorStore.removeTotp(id, { lastFactor: false });
      }
      return result; // an err rolls the transaction back
    });
    if (!created.ok) {
      if (created.error.kind !== 'signed-out') return err({ kind: 'duplicate' });
      // After the rollback: ends the session for good. A session that still fits means the claim itself failed.
      if (await this.#auth[ACCOUNT_STILL_CLAIMED]()) throw claimRefused('passkeys.register()');
      return err(created.error);
    }
    // Once more now that the passkey is committed, with a fresh read and no lock (also for an account without a session key, whose row
    // could not be locked): an ending that landed in between takes it out again. Before the second sign-out below, which writes the hash anew.
    if (!(await this.#auth[ACCOUNT_STILL_CLAIMED]())) {
      try {
        await this.#store.remove(id, created.value.id, { lastFactorAllowed: true });
      } catch (error) {
        this.#logger.error('A passkey was registered for a session that had ended, and taking it out again failed: the passkey may be on without its owner having added it', { user: id, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      return err({ kind: 'signed-out' });
    }

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
    const wait = await this.#waitForSignIn();
    if (wait !== undefined) return err({ kind: 'throttled', retryAfter: wait });
    const checked = await this.#check(response, 'sign-in');
    const signedIn = checked.ok ? await this.#auth[SIGN_IN_VERIFIED](checked.value.userId, options) : undefined;
    if (checked.ok && signedIn?.ok) return ok(signedIn.value);
    // Counted: a failure of any kind (not a success — many people sign in from behind one address).
    await this.#limiter.hit(this.#signInKey(), SIGN_IN_WINDOW.seconds);
    return checked.ok ? err({ kind: 'invalid' }) : checked;
  }

  /**
   * The options for proving a passkey as the second factor of the waiting sign-in: only the account's own passkeys are allowed.
   * `no-challenge` or `expired` without a good pending sign-in.
   */
  async challengeOptions(): Promise<Result<PublicKeyCredentialRequestOptionsJSON, { readonly kind: 'no-challenge' } | { readonly kind: 'expired' }>> {
    const pending = await this.#auth[READ_PENDING]();
    if (pending === undefined) return err({ kind: 'no-challenge' });
    if (pending === 'expired') return err({ kind: 'expired' });
    const { bytes } = issueChallenge(this.#session, 'second-factor', this.#now(), pending.userId);
    const allow = (await this.#store.forUser(pending.userId)).filter((passkey) => passkey.suspendedAt === null).map((passkey) => ({ credentialId: passkey.credentialId, transports: passkey.transports }));
    return ok(await authenticationOptions({ rpId: this.#config.relyingParty().rpId, challenge: bytes, allow }));
  }

  /**
   * The options for proving a passkey again in the session that is signed in, for `TwoFactor.stepUp({ passkey })`: only the signed-in
   * account's own passkeys are allowed, and the challenge is bound to that account. Needs a signed-in user. `no-challenge` when the
   * account has no usable passkey. The route that serves it needs its own limit — it opens a challenge per call.
   */
  async stepUpOptions(): Promise<Result<PublicKeyCredentialRequestOptionsJSON, { readonly kind: 'no-challenge' }>> {
    const user = await this.#requireUser('stepUpOptions');
    const id = idOf(user);
    const allow = (await this.#store.forUser(id)).filter((passkey) => passkey.suspendedAt === null).map((passkey) => ({ credentialId: passkey.credentialId, transports: passkey.transports }));
    if (allow.length === 0) return err({ kind: 'no-challenge' });
    const { bytes } = issueChallenge(this.#session, 'step-up', this.#now(), id);
    return ok(await authenticationOptions({ rpId: this.#config.relyingParty().rpId, challenge: bytes, allow }));
  }

  /** @internal What `TwoFactor.challenge({ passkey })` and `stepUp({ passkey })` call, after they have found the account and counted the attempt. */
  async [VERIFY_SECOND_FACTOR](userId: number | string, assertion: PasskeyAssertion, during: 'sign-in' | 'step-up' = 'sign-in'): Promise<PasskeyVerdict> {
    // No challenge to answer (a timeout, a double submit) is `stale`; only an answer that was given and failed is `wrong`.
    const challenge = await this.#takeChallenge(during === 'step-up' ? 'step-up' : 'second-factor', userId);
    if (!challenge.ok) return 'stale';
    return (await this.#answer(assertion as AuthenticationResponseJSON, challenge.value, userId)).ok ? 'valid' : 'wrong';
  }

  // -- Managing --------------------------------------------------------------------------------------------------------------

  /** The signed-in user's passkeys, oldest first. */
  async list(): Promise<readonly PasskeySummary[]> {
    const user = await this.#requireUser('list');
    return (await this.#store.forUser(idOf(user))).map((passkey) => ({ id: passkey.id, name: passkey.name, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt, suspended: passkey.suspendedAt !== null, synced: passkey.backedUp }));
  }

  /** Renames a passkey of the signed-in user (a recently typed password); `false` for an empty or too long name, or one that is not theirs. */
  async rename(id: number, name: string): Promise<boolean> {
    const user = await this.#requireRecentPassword('rename');
    const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
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
    await this.#requireRecentSecondFactor('remove', userId);
    let lastFactorAllowed = false;
    if (password !== undefined) {
      const checked = await this.#checkPassword(userId, password);
      if (checked.ok) lastFactorAllowed = true;
      else if (checked.error.kind === 'throttled') return err(checked.error);
    }
    // A suspended passkey (a possible clone) goes only with the password: whoever holds the session must not tidy the evidence away.
    const target = (await this.#store.forUser(userId)).find((passkey) => passkey.id === id);
    if (target?.suspendedAt != null && !lastFactorAllowed) return err({ kind: 'invalid-password' });
    const removed = await this.#store.remove(userId, id, { lastFactorAllowed });
    if (!removed.ok) return err(removed.error.kind === 'last-factor' ? { kind: 'invalid-password' } : { kind: 'not-found' });
    await this.#events.dispatch(new PasskeyRemoved(user));
    if (removed.value.lastFactor) await this.#events.dispatch(new TwoFactorDisabled(user, 'user'));
    return ok();
  }

  /**
   * Lets a suspended passkey sign in again — the password typed now, under the throttle of `register()`. `not-found` when the account has
   * no suspended passkey with this id. Suspending is the answer to a sign count that went backwards (a possible clone): the owner decides.
   */
  async release(id: number, password: string): Promise<Result<void, { readonly kind: 'invalid-password' } | { readonly kind: 'not-found' } | { readonly kind: 'throttled'; readonly retryAfter: number }>> {
    const user = await this.#requireRecentPassword('release');
    const userId = idOf(user);
    await this.#requireRecentSecondFactor('release', userId);
    if (!(await this.#store.forUser(userId)).some((passkey) => passkey.id === id && passkey.suspendedAt !== null)) return err({ kind: 'not-found' });
    const checked = await this.#checkPassword(userId, password);
    if (!checked.ok) return err(checked.error);
    return (await this.#store.release(userId, id)) ? ok() : err({ kind: 'not-found' });
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
    const taken = await this.#takeChallenge(purpose, expectedUser);
    if (!taken.ok) return err(taken.error);
    return this.#answer(response, taken.value, expectedUser);
  }

  /**
   * The challenge step: the open challenge leaves the session (it must be for `purpose` and `expectedUser`, and not past its time) and is
   * spent for every process at once — requests that carry the same session cookie at the same moment all read the challenge before any
   * of them removed it, and a synchronised passkey (counter 0) could be replayed without limit.
   */
  async #takeChallenge(purpose: ChallengePurpose, expectedUser?: number | string): Promise<Result<string, PasskeyError>> {
    const taken = takeChallenge(this.#session, purpose, this.#now(), expectedUser);
    if (!taken.ok) return err(taken.error);
    if (!(await this.#spend(taken.value.challenge))) return err({ kind: 'no-challenge' });
    return ok(taken.value.challenge);
  }

  /** The answer step: the passkey, the signature and flags, the sign count — for a challenge already taken. */
  async #answer(response: AuthenticationResponseJSON, challenge: string, expectedUser?: number | string): Promise<Result<PasskeyRecord, PasskeyError>> {
    const purposeIsSignIn = expectedUser === undefined;
    const credentialId = typeof (response as { id?: unknown } | null)?.id === 'string' ? response.id : '';
    const record = credentialId === '' ? undefined : await this.#store.findByCredentialId(credentialId);
    if (record === undefined) return err({ kind: 'invalid' });
    // A passkey proves its own account only: one of another account never completes this sign-in.
    if (expectedUser !== undefined && String(record.userId) !== String(expectedUser)) return err({ kind: 'invalid' });

    const verified = await verifyAuthentication(
      response,
      { ...this.#config.relyingParty(), challenge, discoverable: purposeIsSignIn },
      { credentialId: record.credentialId, publicKey: record.publicKey, signCount: record.signCount, transports: record.transports, userHandle: record.userHandle, backupEligible: record.backupEligible },
      this.#logger,
    );
    if (!verified.ok) {
      const found = await this.#users.findById(record.userId as never);
      if (verified.error.kind === 'clone-suspected') {
        // The counter is not written: the stored one stays the last that was honest. The passkey is suspended — it signs nobody in until
        // its owner releases it with the password — and the owner is told.
        await this.#store.suspend(record.id);
        if (found) await this.#events.dispatch(new PasskeyCloneSuspected(found.user, record.id));
        this.#logger.warn('A passkey answered with a sign count that did not move forward: it may have been copied, and is suspended', { user: record.userId, passkey: record.id });
      } else if (purposeIsSignIn && found) {
        // A passkey that exists answered wrongly (signature, user handle): the owner may want to know. The client learns nothing.
        await this.#events.dispatch(new PasskeySignInFailed(found.user, { ip: this.#request.ip, userAgent: this.#request.userAgent }));
      }
      return err(verified.error);
    }
    if (!(await this.#store.updateCounter(record.id, record.signCount, verified.value.signCount, verified.value.backedUp))) return err({ kind: 'invalid' });
    return ok(record);
  }

  /** The seconds to wait when this address failed too often a minute ago, else `undefined`. */
  async #waitForSignIn(): Promise<number | undefined> {
    const key = this.#signInKey();
    return (await this.#limiter.tooManyAttempts(key, SIGN_IN_WINDOW.attempts)) ? Math.max(1, await this.#limiter.availableIn(key)) : undefined;
  }

  /** Uses a challenge up, atomically: `false` when another request already did. */
  async #spend(challenge: string): Promise<boolean> {
    return this.#limiter.attempt(`passkey-challenge:${createHash('sha256').update(challenge).digest('base64url')}`, 1, CHALLENGE_SECONDS);
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

  /** On an account that has a factor, the session must have proven one lately: the password alone does not change the factors. */
  async #requireRecentSecondFactor(method: string, userId: number | string): Promise<void> {
    if ((await this.#state.factors(userId)).length > 0 && !secondFactorProvenWithin(this.#session, FACTOR_CHANGE_MAX_AGE, this.#now())) {
      throw new Error(`passkeys.${method}() needs a second factor proven within 15 minutes on an account that has one — put the route behind confirmedSecondFactor().`);
    }
  }
}

/** A name for the list: trimmed, control and invisible format characters (bidi overrides, zero-width marks) out, at most 100 characters; `Passkey` when nothing is left. */
function cleanedName(name: string): string {
  const clean = [...name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, MAX_NAME_LENGTH).join('');
  return clean === '' ? 'Passkey' : clean;
}

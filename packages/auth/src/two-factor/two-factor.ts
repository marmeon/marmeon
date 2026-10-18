import { RateLimiter } from '@marmeon/cache';
import { Clock, err, EventDispatcher, Logger, ok, type Result } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { DecryptError, Encrypter } from '@marmeon/encryption';
import { RequestInfo } from '@marmeon/http';
import { CookieJar } from '@marmeon/router';
import { Session, SessionConfig } from '@marmeon/session';
import { ACCOUNT_STILL_CLAIMED, Auth, AUTH_SESSION_KEYS, CLAIM_ACCOUNT, COMPLETE_PENDING, PENDING_MAX_FAILURES, READ_PENDING, RECORD_PENDING_FAILURE } from '../auth.ts';
import { claimRefused } from '../account-sessions.ts';
import { AuthConfig, rememberCookieName } from '../config.ts';
import { RecoveryCodesGenerated, RecoveryCodeUsed, TwoFactorChallengeFailed, TwoFactorEnabled, TwoFactorDisabled } from '../events.ts';
import { RememberTokenStore } from '../remember.ts';
import { idOf, UserProvider, type AuthUser, type AuthUserId } from '../user.ts';
import { FACTOR_CHANGE_MAX_AGE, secondFactorProvenWithin } from './proof.ts';
import { clearPasswordCheck, takePasswordCheck, type PasswordThrottled } from '../password-throttle.ts';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes.ts';
import { qrPath, type QrPath } from './qr.ts';
import { NoTwoFactorState, SecondFactorPasskeys, TwoFactorState, VERIFY_SECOND_FACTOR, type PasskeyAssertion, type PasskeyVerdict, type SecondFactor } from './state.ts';
import { TwoFactorStore } from './store.ts';
import { generateSecret, otpauthUri, verifyTotp } from './totp.ts';

/**
 * Code attempts allowed per account: five a minute, twenty an hour and fifty a day, all counted atomically before the code is
 * checked. Constants, not settings — loosening them is a code review, not a deploy switch. A six-digit code is guessable in
 * hours without them. A success clears only the minute counter, so that hour and day keep what guessing used up.
 */
const TOTP_WINDOWS = [
  { name: 'minute', attempts: 5, seconds: 60 },
  { name: 'hour', attempts: 20, seconds: 3600 },
  { name: 'day', attempts: 50, seconds: 86_400 },
] as const;
/** Recovery codes have 80 bits and cannot be guessed: this counter only limits load, and exhausting the code budget does not close it. */
const RECOVERY_WINDOW = { attempts: 10, seconds: 60 } as const;

/** Why a code did not count. */
export type ChallengeError =
  | { readonly kind: 'no-challenge' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'invalid-code'; readonly attemptsLeft: number }
  | { readonly kind: 'throttled'; readonly retryAfter: number };

/** Why `confirm()` did not turn the factor on. */
export type ConfirmError =
  | { readonly kind: 'not-started' }
  | { readonly kind: 'invalid-password' }
  | { readonly kind: 'invalid-code' }
  | { readonly kind: 'throttled'; readonly retryAfter: number; readonly account?: true }
  /** The session ended while the factor was being set up (another device changed the password, `AccountSessions.end()`): nothing was stored. */
  | { readonly kind: 'signed-out' };

/** What the user needs to set up an authenticator app: the key to type, the `otpauth://` URI, and the QR code of it as one SVG path. */
export interface TotpSetup {
  readonly secret: string;
  readonly uri: string;
  readonly qr: QrPath;
}

/** A code from the authenticator app, a recovery code, or a passkey's sign-in response. */
export type SecondFactorInput = { readonly code: string } | { readonly recoveryCode: string } | { readonly passkey: PasskeyAssertion };

/**
 * The second factor of an account, for this request: finish a sign-in that waits for it, set an authenticator app up, take recovery codes,
 * turn it off. See `docs/two-factor-authentication.md#the-sign-in`.
 *
 * Invariants: a code or recovery code works once (the store decides atomically); every check is throttled per account before it
 * runs; the secret is stored encrypted and bound to its account; nothing here signs anybody in except `challenge()`, and that
 * only for the account the factor was proven for.
 */
export class TwoFactor {
  readonly #auth: Auth;
  readonly #session: Session;
  readonly #state: TwoFactorState;
  readonly #passkeys: SecondFactorPasskeys;
  readonly #store: TwoFactorStore;
  readonly #encrypter: Encrypter;
  readonly #limiter: RateLimiter;
  readonly #remember: RememberTokenStore;
  readonly #events: EventDispatcher;
  readonly #request: RequestInfo;
  readonly #users: UserProvider;
  readonly #cookies: CookieJar;
  readonly #config: AuthConfig;
  readonly #rememberCookie: string;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #connections: Connections;

  constructor(
    auth: Auth,
    session: Session,
    state: TwoFactorState,
    store: TwoFactorStore,
    encrypter: Encrypter,
    limiter: RateLimiter,
    remember: RememberTokenStore,
    events: EventDispatcher,
    request: RequestInfo,
    users: UserProvider,
    cookies: CookieJar,
    config: AuthConfig,
    clock: Clock,
    logger: Logger,
    passkeys: SecondFactorPasskeys,
    connections: Connections,
    sessionConfig: SessionConfig,
  ) {
    this.#auth = auth;
    this.#session = session;
    this.#state = state;
    this.#store = store;
    this.#encrypter = encrypter;
    this.#limiter = limiter;
    this.#remember = remember;
    this.#events = events;
    this.#request = request;
    this.#users = users;
    this.#cookies = cookies;
    this.#config = config;
    this.#clock = clock;
    this.#logger = logger;
    this.#passkeys = passkeys;
    this.#connections = connections;
    this.#rememberCookie = rememberCookieName(config, sessionConfig);
  }

  /**
   * Finishes the sign-in that waits for a second factor, with a code from the authenticator app or a recovery code. `ok` with the
   * user — now signed in, in a new session — or why not. The fifth wrong code drops the waiting sign-in (the password is typed again).
   */
  async challenge(input: SecondFactorInput): Promise<Result<AuthUser, ChallengeError>> {
    // Order: the waiting sign-in, its account and fingerprint, the throttle, the code. A sign-in that ended (password changed, account gone)
    // is refused before any code or recovery code is used up and before any event fires.
    const pending = await this.#auth[READ_PENDING]();
    if (pending === undefined) return err({ kind: 'no-challenge' });
    if (pending === 'expired') return err({ kind: 'expired' });
    const userId = pending.userId;
    // Recovery codes and passkeys cannot be guessed (80 bits; a signature): they share the generous counter, not the code budget.
    const recovery = 'recoveryCode' in input || 'passkey' in input;
    const wait = recovery ? await this.#throttleRecovery(userId) : await this.#throttleCodes(userId);
    if (wait !== undefined) return err({ kind: 'throttled', retryAfter: wait });

    const verdict = await this.#verify(userId, input);
    if (verdict !== 'valid') {
      const failures = this.#auth[RECORD_PENDING_FAILURE]() ?? PENDING_MAX_FAILURES;
      const found = await this.#users.findById(userId as never);
      // The owner is told of a wrong answer only, not of a challenge that timed out or was sent twice: the client sees `invalid-code` either way.
      if (found && verdict === 'wrong') await this.#events.dispatch(new TwoFactorChallengeFailed(found.user, new Date(this.#clock.now()), { ip: this.#request.ip, userAgent: this.#request.userAgent, during: 'sign-in' }));
      return err({ kind: 'invalid-code', attemptsLeft: Math.max(0, PENDING_MAX_FAILURES - failures) });
    }
    // Only the minute counter: hour and day keep the attempts that guessing used up.
    await this.#limiter.clear(recovery ? this.#recoveryKey(userId) : this.#codeKey('minute', userId));
    // Signs in only the account the factor was proven for: a pending sign-in of another account is refused there.
    const done = await this.#auth[COMPLETE_PENDING](userId);
    return done.ok ? ok(done.value) : err(done.error);
  }

  /**
   * Proves the second factor again for the signed-in user (a code, a recovery code or a passkey from `passkeys.stepUpOptions()`), in the session they already have — what the `twoFactor()` middleware sends
   * people to when this session has not proven it (or too long ago). `ok` once the code counts: the session is then marked as having
   * proven it, under a new session id. Same throttle, same events and same errors as `challenge()`, except that wrong codes do not
   * end the session (`attemptsLeft` counts down the minute's budget); `no-challenge` when the account has no factor to prove.
   * Needs a signed-in user.
   */
  async stepUp(input: SecondFactorInput): Promise<Result<void, ChallengeError>> {
    const user = await this.#requireUser('stepUp');
    const userId = idOf(user);
    if ((await this.#state.factors(userId)).length === 0) return err({ kind: 'no-challenge' });
    // A passkey shares the generous counter with recovery codes (it cannot be guessed); a failure ends no session, so it is not the TOTP budget.
    const recovery = 'recoveryCode' in input || 'passkey' in input;
    const wait = recovery ? await this.#throttleRecovery(userId) : await this.#throttleCodes(userId);
    if (wait !== undefined) return err({ kind: 'throttled', retryAfter: wait });

    const minute = recovery ? this.#recoveryKey(userId) : this.#codeKey('minute', userId);
    const verdict = await this.#verify(userId, input, 'step-up');
    if (verdict !== 'valid') {
      if (verdict === 'wrong') await this.#events.dispatch(new TwoFactorChallengeFailed(user, new Date(this.#clock.now()), { ip: this.#request.ip, userAgent: this.#request.userAgent, during: 'step-up' }));
      const budget = recovery ? RECOVERY_WINDOW.attempts : TOTP_WINDOWS[0].attempts;
      return err({ kind: 'invalid-code', attemptsLeft: Math.max(0, budget - (await this.#limiter.attempts(minute))) });
    }
    await this.#limiter.clear(minute);
    // The session gains a privilege it did not have: a new id, as at sign-in, so that an id known from before is worth nothing now.
    this.#session.regenerate();
    this.#session.put(AUTH_SESSION_KEYS.twoFactorAt, this.#now()); // seconds, from the same clock as `confirmedAt` and the sign-in, which `twoFactor()` reads
    return ok(undefined);
  }

  /** What the settings page shows: the factors, whether an authenticator is being set up, and how many recovery codes are left. Needs a signed-in user. */
  async status(): Promise<{ factors: readonly SecondFactor[]; settingUpTotp: boolean; recoveryCodesLeft: number }> {
    const user = await this.#requireUser('status');
    const id = idOf(user);
    const [factors, row, recoveryCodesLeft] = await Promise.all([this.#state.factors(id), this.#store.find(id), this.#store.remainingRecoveryCodes(id)]);
    return { factors, settingUpTotp: row !== undefined && !row.confirmed, recoveryCodesLeft };
  }

  /**
   * Starts setting up an authenticator app: a new key, not yet in force. Needs a signed-in user with a recent confirmation
   * (`confirmedPassword()`: a password or a passkey); throws when an authenticator is already on (turn it off first), when no source of factors is bound
   * (`TwoFactorState` is still the default that knows none, so the factor would never be asked for) and for an account without a
   * password (turning the factor on checks it, and signs the other devices out with a new session key). Replaces an earlier unconfirmed key.
   */
  async begin(): Promise<TotpSetup> {
    const user = await this.#requireUser('begin');
    // Without a bound source of factors a confirmed factor would never be asked for at sign-in: fail closed before anything is stored.
    if (this.#state instanceof NoTwoFactorState) throw new Error('Two-factor authentication needs a source of factors: bind TwoFactorState to combineFactors(TwoFactorStore) in a provider of your auth module.');
    // Turning the factor on is confirmed with the account's password (and signs the other devices out with a new session key): an account without one cannot do it.
    if (((await this.#users.findById(idOf(user) as never))?.passwordHash ?? null) === null) throw new Error('twoFactor.begin() needs an account with a password: turning the factor on signs out the other devices with it.');
    await this.#requireRecentPassword('begin');
    await this.#requireRecentSecondFactor('begin', idOf(user));
    this.#issuer(); // before anything is stored: a missing app name leaves no half-made setup behind
    const secret = generateSecret();
    await this.#store.startSetup(idOf(user), await this.#encrypt(secret, idOf(user)));
    return this.#describe(user, secret);
  }

  /** The setup that was begun but not confirmed, to show it again (a reloaded page); `undefined` when there is none. Same requirements as `begin()`. */
  async setup(): Promise<TotpSetup | undefined> {
    const user = await this.#requireRecentPassword('setup');
    await this.#requireRecentSecondFactor('setup', idOf(user));
    const row = await this.#store.find(idOf(user));
    if (row === undefined || row.confirmed) return undefined;
    const secret = await this.#decrypt(row.encryptedSecret, idOf(user));
    return secret === undefined ? undefined : this.#describe(user, secret);
  }

  /**
   * Turns the authenticator on with the first code it shows and the account's password, typed in the same form. Throttled like a
   * challenge. Every other device is signed out: its sessions end (a new session key, so their fingerprints stop matching)
   * and so do its remember-me tokens — each session of the account has then proven a second factor. API tokens are not touched.
   * `recoveryCodes` are the account's new codes, shown now and never again, when this is its first factor, else `null`.
   *
   * Order: the password check counts and the password is checked, the code budget counts, the code is checked without writing, the other devices are signed out, and
   * only then the step is stored and the factor switched on.
   */
  async confirm(code: string, password: string): Promise<Result<{ recoveryCodes: readonly string[] | null }, ConfirmError>> {
    const user = await this.#requireUser('confirm');
    const id = idOf(user);
    const row = await this.#store.find(id);
    if (row === undefined || row.confirmed) return err({ kind: 'not-started' });
    // The password first, under its own windows: only whoever knows it spends the account's budget of codes.
    const scope = this.#auth.passwordCheckScope();
    const held = await takePasswordCheck(this.#limiter, scope, id);
    if (held !== undefined) return err(held);
    if (!(await this.#auth.confirmPassword(password))) return err({ kind: 'invalid-password' });
    await clearPasswordCheck(this.#limiter, scope);
    const wait = await this.#throttleCodes(id);
    if (wait !== undefined) return err({ kind: 'throttled', retryAfter: wait });

    const secret = await this.#decrypt(row.encryptedSecret, id);
    const step = secret === undefined ? undefined : verifyTotp(secret, code, new Date(this.#clock.now()));
    if (secret === undefined || step === undefined) return err({ kind: 'invalid-code' });

    const first = (await this.#state.factors(id)).length === 0;
    const recoveryCodes = first ? generateRecoveryCodes() : null;
    // Before the factor is on, so that a failure after this point leaves the factor off and the other devices out — never the factor on
    // and an old session alive. A remember-me token made between here and the update is refused by its date (`enabledSince`).
    // `false`: this device's remember-me cookie was a copy, and everything of the account is ended, this session too.
    if (!(await this.#auth.updateSessionKey())) return err({ kind: 'signed-out' });
    const encrypted = await this.#encrypt(secret, id);
    const hashes = recoveryCodes === null ? null : recoveryCodes.map((recoveryCode) => hashRecoveryCode(id, recoveryCode));
    // The session is checked against the account in the transaction that stores the factor (with a session key, the account's row stays
    // locked until the commit): a session that ended meanwhile stores nothing.
    const stored = await this.#connections.transaction(async () => {
      if (!(await this.#auth[CLAIM_ACCOUNT]())) return err({ kind: 'signed-out' } as const);
      return ok(await this.#store.confirm(id, step, encrypted, hashes));
    });
    if (!stored.ok) {
      // After the rollback: ends the session for good. A session that still fits means the claim itself failed.
      if (await this.#auth[ACCOUNT_STILL_CLAIMED]()) throw claimRefused('twoFactor.confirm()');
      return err(stored.error);
    }
    if (!stored.value) return err({ kind: 'not-started' });
    // Once more now that the factor is committed, with a fresh read and no lock (also for an account without a session key, whose row
    // could not be locked): an ending that landed in between takes the factor out again. Before the second sign-out below, which
    // writes the key anew.
    if (!(await this.#auth[ACCOUNT_STILL_CLAIMED]())) {
      try {
        await this.#store.removeTotp(id, { lastFactor: (await this.#state.factors(id)).every((factor) => factor === 'totp') });
      } catch (error) {
        this.#logger.error('Two-factor authentication was turned on for a session that had ended, and taking it out again failed: the factor may be on without its owner having set it up', { user: id, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      return err({ kind: 'signed-out' });
    }
    // Once more, now that the factor is committed: a session or remember-me token made in the window between the first sign-out and the
    // commit (its sign-in read "no factor") dies here. Later sign-ins see the factor and are held back. This device's token goes too,
    // as after a password change: the next sign-in makes a new one after the code.
    try {
      await this.#auth.updateSessionKey();
      await this.#remember.forgetUser(id);
    } catch (error) {
      // The factor stays on (later sign-ins are asked for it); what is left to end are sessions that raced the activation: tell the operators.
      this.#logger.error('Two-factor authentication was turned on, but signing out the other devices a second time failed: sessions made while it was turned on may be open', { user: id, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    this.#cookies.delete(this.#rememberCookie);
    // The state must see the factor, else sign-in would never ask for it: a state bound to something else than the store fails closed here.
    if (!(await this.#state.factors(id)).includes('totp')) {
      await this.#store.removeTotp(id, { lastFactor: (await this.#state.factors(id)).every((factor) => factor === 'totp') });
      throw new Error('The TwoFactorState does not report the authenticator that was just confirmed: bind it to combineFactors(TwoFactorStore). The confirmation was rolled back.');
    }
    // Only the first factor proves anything about this session: a further one, set up with just the password, must not stand for the one already there.
    if (first) this.#session.put(AUTH_SESSION_KEYS.twoFactorAt, this.#now());
    await this.#limiter.clear(this.#codeKey('minute', id));
    await this.#events.dispatch(new TwoFactorEnabled(user, 'totp'));
    if (first) await this.#events.dispatch(new RecoveryCodesGenerated(user));
    return ok({ recoveryCodes });
  }

  /**
   * New recovery codes, replacing all the old ones (spent or not); shown once. Needs a recent confirmation (`confirmedPassword()`: a
   * password or a passkey), a factor, and the password again in the same form — a passkey alone must not be able to void the owner's
   * codes. The check is counted per sign-in and account (see `takePasswordCheck()`). `invalid-password` and `throttled` change nothing.
   */
  async regenerateRecoveryCodes(password: string): Promise<Result<readonly string[], { readonly kind: 'invalid-password' } | PasswordThrottled>> {
    const user = await this.#requireRecentPassword('regenerateRecoveryCodes');
    const id = idOf(user);
    if ((await this.#state.factors(id)).length === 0) throw new Error('twoFactor.regenerateRecoveryCodes() needs a second factor: recovery codes belong to one.');
    await this.#requireRecentSecondFactor('regenerateRecoveryCodes', id);
    // An empty password is none: nothing is counted, there is nothing to guess.
    if (password === '') return err({ kind: 'invalid-password' });
    const scope = this.#auth.passwordCheckScope();
    const held = await takePasswordCheck(this.#limiter, scope, id);
    if (held !== undefined) return err(held);
    if (!(await this.#auth.confirmPassword(password))) return err({ kind: 'invalid-password' });
    await clearPasswordCheck(this.#limiter, scope);
    const codes = generateRecoveryCodes();
    await this.#store.replaceRecoveryCodes(id, codes.map((recoveryCode) => hashRecoveryCode(id, recoveryCode)));
    await this.#events.dispatch(new RecoveryCodesGenerated(user));
    return ok(codes);
  }

  /**
   * Turns the authenticator off — only with the account's password typed now. `false` means a wrong password and nothing changed (it
   * does not throttle the check: the caller must, with `takePasswordCheck()`); with the right one it is `true`, also when only an unfinished setup existed (that is removed).
   * The recovery codes go with the last factor.
   */
  async disable(password: string): Promise<boolean> {
    const user = await this.#requireUser('disable');
    const id = idOf(user);
    if (!(await this.#auth.confirmPassword(password))) return false;
    const factors = await this.#state.factors(id);
    // An unfinished setup on an account without the authenticator takes nothing away, so it needs no proof.
    if (factors.includes('totp')) await this.#requireRecentSecondFactor('disable', id);
    if (!factors.includes('totp')) {
      await this.#store.removeTotp(id, { lastFactor: false }); // an unconfirmed setup, if any; nothing was in force
      return true;
    }
    await this.#store.removeTotp(id, { lastFactor: factors.every((factor) => factor === 'totp') });
    await this.#events.dispatch(new TwoFactorDisabled(user, 'user'));
    return true;
  }

  /** Whether `input` is a valid second factor of the account right now — checked against the store, not against what the sign-in saw. */
  async #verify(userId: AuthUserId, input: SecondFactorInput, during: 'sign-in' | 'step-up' = 'sign-in'): Promise<PasskeyVerdict> {
    if ('passkey' in input) return this.#passkeys[VERIFY_SECOND_FACTOR](userId, input.passkey, during);
    return (await this.#verifyCode(userId, input)) ? 'valid' : 'wrong';
  }

  async #verifyCode(userId: AuthUserId, input: Exclude<SecondFactorInput, { passkey: unknown }>): Promise<boolean> {
    if ('recoveryCode' in input) {
      // Recovery codes need no secret that decrypts; they work while the account has any factor.
      if ((await this.#state.factors(userId)).length === 0) return false;
      const remaining = await this.#store.consumeRecoveryCode(userId, hashRecoveryCode(userId, input.recoveryCode));
      if (remaining === undefined) return false;
      const found = await this.#users.findById(userId as never);
      if (found) await this.#events.dispatch(new RecoveryCodeUsed(found.user, remaining));
      return true;
    }
    const row = await this.#store.find(userId);
    // An unconfirmed setup never counts.
    if (row === undefined || !row.confirmed) return false;
    const secret = await this.#decrypt(row.encryptedSecret, userId);
    if (secret === undefined) return false;
    const step = verifyTotp(secret, input.code, new Date(this.#clock.now()));
    if (step === undefined) return false;
    // The step is used up atomically (and the secret re-encrypted with the current key) — a code works once, even in parallel.
    return this.#store.useStep(userId, step, await this.#encrypt(secret, userId));
  }

  #now(): number {
    return Math.floor(this.#clock.now() / 1000);
  }

  // Per account only: a password reset, which whoever controls the mailbox can ask for, must not hand out fresh attempts.
  #codeKey(window: (typeof TOTP_WINDOWS)[number]['name'], userId: AuthUserId): string {
    return `two-factor-${window}:${userId}`;
  }

  #recoveryKey(userId: AuthUserId): string {
    return `two-factor-recovery:${userId}`;
  }

  /** Counts one code attempt in the three windows; the seconds to wait when any is used up, else `undefined`. */
  async #throttleCodes(userId: AuthUserId): Promise<number | undefined> {
    const waits: number[] = [];
    for (const window of TOTP_WINDOWS) {
      const key = this.#codeKey(window.name, userId);
      if (!(await this.#limiter.attempt(key, window.attempts, window.seconds))) waits.push(await this.#limiter.availableIn(key));
    }
    return waits.length === 0 ? undefined : Math.max(1, ...waits);
  }

  async #throttleRecovery(userId: AuthUserId): Promise<number | undefined> {
    const key = this.#recoveryKey(userId);
    return (await this.#limiter.attempt(key, RECOVERY_WINDOW.attempts, RECOVERY_WINDOW.seconds)) ? undefined : Math.max(1, await this.#limiter.availableIn(key));
  }

  /** The secret is bound to its account: a row copied to another account does not decrypt there. */
  #encrypt(secret: string, userId: AuthUserId): Promise<string> {
    return this.#encrypter.encrypt(secret, context(userId));
  }

  async #decrypt(payload: string, userId: AuthUserId): Promise<string | undefined> {
    try {
      return await this.#encrypter.decrypt(payload, context(userId));
    } catch (error) {
      if (error instanceof DecryptError) return undefined;
      throw error;
    }
  }

  #issuer(): string {
    const issuer = this.#config.appName;
    if (issuer === undefined || issuer.trim() === '') throw new Error('Two-factor authentication needs the app\'s name for the authenticator app: set APP_NAME.');
    return issuer;
  }

  #describe(user: AuthUser, secret: string): TotpSetup {
    const issuer = this.#issuer();
    const account = (user as { email?: unknown }).email;
    const uri = otpauthUri({ issuer, account: typeof account === 'string' ? account : String(idOf(user)), secret });
    return { secret, uri, qr: qrPath(uri) };
  }

  /**
   * For an action of your own that weighs as much as changing a factor (a new e-mail address, an API token): throws unless this
   * session proved a second factor within the last 15 minutes, on an account that has one; an account without a factor passes.
   * `action` is named in the error message. Put the route behind `confirmedSecondFactor()` to send a stale session to the page
   * that asks again. See `docs/two-factor-authentication.md#changing-the-factors`.
   */
  async requireRecentProof(action: string): Promise<void> {
    const user = await this.#requireUser('requireRecentProof');
    await this.#requireRecentSecondFactor('requireRecentProof', idOf(user), `requireRecentProof('${action}')`);
  }

  async #requireUser(method: string): Promise<AuthUser> {
    const user = await this.#auth.user();
    if (!user) throw new Error(`twoFactor.${method}() needs a signed-in user — put the route behind authenticate().`);
    return user;
  }

  async #requireRecentPassword(method: string): Promise<AuthUser> {
    const user = await this.#requireUser(method);
    if (!this.#auth.passwordRecentlyConfirmed()) throw new Error(`twoFactor.${method}() needs a recent confirmation (a password or a passkey) — put the route behind confirmedPassword().`);
    return user;
  }

  /** On an account that has a factor, the session must have proven one lately: the password alone does not change the factors. */
  async #requireRecentSecondFactor(method: string, userId: AuthUserId, call = `${method}()`): Promise<void> {
    if ((await this.#state.factors(userId)).length > 0 && !secondFactorProvenWithin(this.#session, FACTOR_CHANGE_MAX_AGE, this.#now())) {
      throw new Error(`twoFactor.${call} needs a second factor proven within 15 minutes on an account that has one — put the route behind confirmedSecondFactor().`);
    }
  }
}

function context(userId: AuthUserId): string {
  return `marmeon-auth:two-factor:${userId}`;
}

import { RateLimiter } from '@marmeon/cache';
import { Clock, err, EventDispatcher, Logger, ok, type Result } from '@marmeon/core';
import { DecryptError, Encrypter } from '@marmeon/encryption';
import { RequestInfo } from '@marmeon/http';
import { CookieJar } from '@marmeon/router';
import { Session } from '@marmeon/session';
import { Auth, AUTH_SESSION_KEYS, COMPLETE_PENDING, PENDING_MAX_FAILURES, READ_PENDING, RECORD_PENDING_FAILURE, SIGN_OUT_OTHER_DEVICES } from '../auth.ts';
import { AuthConfig } from '../config.ts';
import { RecoveryCodesGenerated, RecoveryCodeUsed, TwoFactorChallengeFailed, TwoFactorEnabled, TwoFactorDisabled } from '../events.ts';
import { RememberTokenStore } from '../remember.ts';
import { idOf, UserProvider, type AuthUser } from '../user.ts';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes.ts';
import { qrPath, type QrPath } from './qr.ts';
import { NoTwoFactorState, TwoFactorState, type SecondFactor } from './state.ts';
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
  | { readonly kind: 'throttled'; readonly retryAfter: number };

/** What the user needs to set up an authenticator app: the key to type, the `otpauth://` URI, and the QR code of it as one SVG path. */
export interface TotpSetup {
  readonly secret: string;
  readonly uri: string;
  readonly qr: QrPath;
}

/** A code from the authenticator app, or a recovery code. */
export type SecondFactorInput = { readonly code: string } | { readonly recoveryCode: string };

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
  readonly #store: TwoFactorStore;
  readonly #encrypter: Encrypter;
  readonly #limiter: RateLimiter;
  readonly #remember: RememberTokenStore;
  readonly #events: EventDispatcher;
  readonly #request: RequestInfo;
  readonly #users: UserProvider;
  readonly #cookies: CookieJar;
  readonly #config: AuthConfig;
  readonly #clock: Clock;
  readonly #logger: Logger;

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
    const recovery = 'recoveryCode' in input;
    const wait = recovery ? await this.#throttleRecovery(userId) : await this.#throttleCodes(userId);
    if (wait !== undefined) return err({ kind: 'throttled', retryAfter: wait });

    if (!(await this.#verify(userId, input))) {
      const failures = this.#auth[RECORD_PENDING_FAILURE]() ?? PENDING_MAX_FAILURES;
      const found = await this.#users.findById(userId as never);
      if (found) await this.#events.dispatch(new TwoFactorChallengeFailed(found.user, new Date(this.#clock.now()), { ip: this.#request.ip, userAgent: this.#request.userAgent }));
      return err({ kind: 'invalid-code', attemptsLeft: Math.max(0, PENDING_MAX_FAILURES - failures) });
    }
    // Only the minute counter: hour and day keep the attempts that guessing used up.
    await this.#limiter.clear(recovery ? this.#recoveryKey(userId) : this.#codeKey('minute', userId));
    // Signs in only the account the factor was proven for: a pending sign-in of another account is refused there.
    const done = await this.#auth[COMPLETE_PENDING](userId);
    return done.ok ? ok(done.value) : err(done.error);
  }

  /** What the settings page shows: the factors, whether an authenticator is being set up, and how many recovery codes are left. Needs a signed-in user. */
  async status(): Promise<{ factors: readonly SecondFactor[]; settingUpTotp: boolean; recoveryCodesLeft: number }> {
    const user = await this.#requireUser('status');
    const id = idOf(user);
    const [factors, row, recoveryCodesLeft] = await Promise.all([this.#state.factors(id), this.#store.find(id), this.#store.remainingRecoveryCodes(id)]);
    return { factors, settingUpTotp: row !== undefined && !row.confirmed, recoveryCodesLeft };
  }

  /**
   * Starts setting up an authenticator app: a new key, not yet in force. Needs a signed-in user who typed the password recently
   * (`confirmedPassword()`); throws when an authenticator is already on (turn it off first), when no source of factors is bound
   * (`TwoFactorState` is still the default that knows none, so the factor would never be asked for) and for an account without a
   * password (turning the factor on signs the other devices out, which takes the hash). Replaces an earlier unconfirmed key.
   */
  async begin(): Promise<TotpSetup> {
    const user = await this.#requireUser('begin');
    // Without a bound source of factors a confirmed factor would never be asked for at sign-in: fail closed before anything is stored.
    if (this.#state instanceof NoTwoFactorState) throw new Error('Two-factor authentication needs a source of factors: bind TwoFactorState to combineFactors(TwoFactorStore) in a provider of your auth module.');
    // Turning the factor on signs the other devices out, which needs the password hash: an account without a password cannot do it.
    if (((await this.#users.findById(idOf(user) as never))?.passwordHash ?? null) === null) throw new Error('twoFactor.begin() needs an account with a password: turning the factor on signs out the other devices with it.');
    await this.#requireRecentPassword('begin');
    this.#issuer(); // before anything is stored: a missing app name leaves no half-made setup behind
    const secret = generateSecret();
    await this.#store.startSetup(idOf(user), await this.#encrypt(secret, idOf(user)));
    return this.#describe(user, secret);
  }

  /** The setup that was begun but not confirmed, to show it again (a reloaded page); `undefined` when there is none. Same requirements as `begin()`. */
  async setup(): Promise<TotpSetup | undefined> {
    const user = await this.#requireRecentPassword('setup');
    const row = await this.#store.find(idOf(user));
    if (row === undefined || row.confirmed) return undefined;
    const secret = await this.#decrypt(row.encryptedSecret, idOf(user));
    return secret === undefined ? undefined : this.#describe(user, secret);
  }

  /**
   * Turns the authenticator on with the first code it shows and the account's password, typed in the same form. Throttled like a
   * challenge. Every other device is signed out: its sessions end (the password is hashed anew, so their fingerprints stop matching)
   * and so do its remember-me tokens — each session of the account has then proven a second factor. API tokens are not touched.
   * `recoveryCodes` are the account's new codes, shown now and never again, when this is its first factor, else `null`.
   *
   * Order: the throttle counts, the password is checked, the code is checked without writing, the other devices are signed out, and
   * only then the step is stored and the factor switched on.
   */
  async confirm(code: string, password: string): Promise<Result<{ recoveryCodes: readonly string[] | null }, ConfirmError>> {
    const user = await this.#requireUser('confirm');
    const id = idOf(user);
    const row = await this.#store.find(id);
    if (row === undefined || row.confirmed) return err({ kind: 'not-started' });
    const wait = await this.#throttleCodes(id);
    if (wait !== undefined) return err({ kind: 'throttled', retryAfter: wait });
    if (!(await this.#auth.confirmPassword(password))) return err({ kind: 'invalid-password' });

    const secret = await this.#decrypt(row.encryptedSecret, id);
    const step = secret === undefined ? undefined : verifyTotp(secret, code, new Date(this.#clock.now()));
    if (secret === undefined || step === undefined) return err({ kind: 'invalid-code' });

    const first = (await this.#state.factors(id)).length === 0;
    const recoveryCodes = first ? generateRecoveryCodes() : null;
    // Before the factor is on, so that a failure after this point leaves the factor off and the other devices out — never the factor on
    // and an old session alive. A remember-me token made between here and the update is refused by its date (`enabledSince`).
    await this.#auth[SIGN_OUT_OTHER_DEVICES](password);
    const confirmed = await this.#store.confirm(id, step, await this.#encrypt(secret, id), recoveryCodes === null ? null : recoveryCodes.map((recoveryCode) => hashRecoveryCode(id, recoveryCode)));
    if (!confirmed) return err({ kind: 'not-started' });
    // Once more, now that the factor is committed: a session or remember-me token made in the window between the first sign-out and the
    // commit (its sign-in read "no factor") dies here. Later sign-ins see the factor and are held back. This device's token goes too,
    // as after a password change: the next sign-in makes a new one after the code.
    try {
      await this.#auth[SIGN_OUT_OTHER_DEVICES](password);
      await this.#remember.forgetUser(id);
    } catch (error) {
      // The factor stays on (later sign-ins are asked for it); what is left to end are sessions that raced the activation: tell the operators.
      this.#logger.error('Two-factor authentication was turned on, but signing out the other devices a second time failed: sessions made while it was turned on may be open', { user: id, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    this.#cookies.delete(this.#config.rememberCookie);
    // The state must see the factor, else sign-in would never ask for it: a state bound to something else than the store fails closed here.
    if (!(await this.#state.factors(id)).includes('totp')) {
      await this.#store.removeTotp(id, { lastFactor: first });
      throw new Error('The TwoFactorState does not report the authenticator that was just confirmed: bind it to combineFactors(TwoFactorStore). The confirmation was rolled back.');
    }
    this.#session.put(AUTH_SESSION_KEYS.twoFactorAt, Math.floor(this.#clock.now() / 1000));
    await this.#limiter.clear(this.#codeKey('minute', id));
    await this.#events.dispatch(new TwoFactorEnabled(user, 'totp'));
    if (first) await this.#events.dispatch(new RecoveryCodesGenerated(user));
    return ok({ recoveryCodes });
  }

  /** New recovery codes, replacing all the old ones (spent or not); shown once. Needs a recently typed password and a factor. */
  async regenerateRecoveryCodes(): Promise<readonly string[]> {
    const user = await this.#requireRecentPassword('regenerateRecoveryCodes');
    const id = idOf(user);
    if ((await this.#state.factors(id)).length === 0) throw new Error('twoFactor.regenerateRecoveryCodes() needs a second factor: recovery codes belong to one.');
    const codes = generateRecoveryCodes();
    await this.#store.replaceRecoveryCodes(id, codes.map((recoveryCode) => hashRecoveryCode(id, recoveryCode)));
    await this.#events.dispatch(new RecoveryCodesGenerated(user));
    return codes;
  }

  /**
   * Turns the authenticator off — only with the account's password typed now. `false` means a wrong password and nothing changed (the
   * caller throttles password checks); with the right one it is `true`, also when only an unfinished setup existed (that is removed).
   * The recovery codes go with the last factor.
   */
  async disable(password: string): Promise<boolean> {
    const user = await this.#requireUser('disable');
    const id = idOf(user);
    if (!(await this.#auth.confirmPassword(password))) return false;
    const factors = await this.#state.factors(id);
    if (!factors.includes('totp')) {
      await this.#store.removeTotp(id, { lastFactor: false }); // an unconfirmed setup, if any; nothing was in force
      return true;
    }
    await this.#store.removeTotp(id, { lastFactor: factors.every((factor) => factor === 'totp') });
    await this.#events.dispatch(new TwoFactorDisabled(user, 'user'));
    return true;
  }

  /** Whether `input` is a valid second factor of the account right now — checked against the store, not against what the sign-in saw. */
  async #verify(userId: string | number, input: SecondFactorInput): Promise<boolean> {
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

  // Per account only: a password reset, which whoever controls the mailbox can ask for, must not hand out fresh attempts.
  #codeKey(window: (typeof TOTP_WINDOWS)[number]['name'], userId: string | number): string {
    return `two-factor-${window}:${userId}`;
  }

  #recoveryKey(userId: string | number): string {
    return `two-factor-recovery:${userId}`;
  }

  /** Counts one code attempt in the three windows; the seconds to wait when any is used up, else `undefined`. */
  async #throttleCodes(userId: string | number): Promise<number | undefined> {
    const waits: number[] = [];
    for (const window of TOTP_WINDOWS) {
      const key = this.#codeKey(window.name, userId);
      if (!(await this.#limiter.attempt(key, window.attempts, window.seconds))) waits.push(await this.#limiter.availableIn(key));
    }
    return waits.length === 0 ? undefined : Math.max(1, ...waits);
  }

  async #throttleRecovery(userId: string | number): Promise<number | undefined> {
    const key = this.#recoveryKey(userId);
    return (await this.#limiter.attempt(key, RECOVERY_WINDOW.attempts, RECOVERY_WINDOW.seconds)) ? undefined : Math.max(1, await this.#limiter.availableIn(key));
  }

  /** The secret is bound to its account: a row copied to another account does not decrypt there. */
  #encrypt(secret: string, userId: string | number): Promise<string> {
    return this.#encrypter.encrypt(secret, context(userId));
  }

  async #decrypt(payload: string, userId: string | number): Promise<string | undefined> {
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

  async #requireUser(method: string): Promise<AuthUser> {
    const user = await this.#auth.user();
    if (!user) throw new Error(`twoFactor.${method}() needs a signed-in user — put the route behind authenticate().`);
    return user;
  }

  async #requireRecentPassword(method: string): Promise<AuthUser> {
    const user = await this.#requireUser(method);
    if (!this.#auth.passwordRecentlyConfirmed()) throw new Error(`twoFactor.${method}() needs a recently typed password — put the route behind confirmedPassword().`);
    return user;
  }
}

function context(userId: string | number): string {
  return `marmeon-auth:two-factor:${userId}`;
}

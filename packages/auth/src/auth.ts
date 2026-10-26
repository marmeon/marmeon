import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { afterCommit, afterRollback, Clock, durationToSeconds, err, EventDispatcher, Logger, ok, type Duration, type Result } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { ClientHistory, ClientInfo } from '@marmeon/http';
import { CookieJar } from '@marmeon/router';
import { Session, SessionConfig } from '@marmeon/session';
import { ANNOUNCE_ENDED, AccountSessions, missingSessionKeyMethod, notABoolean, passwordHashWritten, rotateSessionKey } from './account-sessions.ts';
import { CLOCK_SKEW_SECONDS } from './clock-skew.ts';
import { AuthConfig, rememberCookieName } from './config.ts';
import { SignInFailed, SignInLockedOut, SignedIn, MAX_USER_AGENT, SignedOut, PasswordChanged, RememberTokenReused, type SignInVia } from './events.ts';
import { Hasher } from './hashing.ts';
import { AUTH_SESSION_KEYS, readAuth, writeAuth, type PendingSecondFactor } from './session-keys.ts';
import { SessionFingerprints } from './fingerprint.ts';
import { SignInThrottle, type DeviceCookie } from './sign-in-throttle.ts';
import { AccountClaimLost, NewPassword } from './new-password.ts';
import { clearPasswordCheck, takePasswordCheck, type PasswordCheckError, type PasswordCheckScope } from './password-throttle.ts';
import { describeDevice } from './device.ts';
import { SignInStore, type SignIn } from './sign-ins.ts';
import { TwoFactorState, type SecondFactor } from './two-factor/state.ts';
import { assertSignInFinder, idOf, UserProvider, type AuthUser, type AuthUserId, type Credentials } from './user.ts';
import { RateLimiter } from '@marmeon/cache';

export { AUTH_SESSION_KEYS, type PendingSecondFactor } from './session-keys.ts';

/** How long a correct password waits for the second factor, in seconds. */
export const PENDING_SECONDS = 300;

/** Reads the pending state (package-internal, for `TwoFactor`): the account it names, and how often a factor failed. `undefined` when none waits or it ran out. */
export const READ_PENDING = Symbol('marmeon.auth.readPending');


/**
 * Checks this session against the account, in the transaction of the caller (package-internal): `TwoFactor.confirm()` and
 * `Passkeys.register()` call it as the first step of the transaction that stores a new factor.
 */
export const CLAIM_ACCOUNT = Symbol('marmeon.auth.claimAccount');

/** The check of `CLAIM_ACCOUNT` without the lock (package-internal): runs after every commit of a factor, and after a rollback that `CLAIM_ACCOUNT` asked for. */
export const ACCOUNT_STILL_CLAIMED = Symbol('marmeon.auth.accountStillClaimed');

/** The session key of the account this request verified (package-internal): `string`, or `null` for an account without one. Throws without a verified sign-in. */
export const VERIFIED_SESSION_KEY = Symbol('marmeon.auth.verifiedSessionKey');

/**
 * Takes the remember-me token off the sign-in of this session (package-internal): the factor that was just turned on makes this
 * device's token one that never proved it. The session and its row stay; the caller removes the cookie.
 */
export const DROP_REMEMBER_TOKEN = Symbol('marmeon.auth.dropRememberToken');

/** Counts a wrong second factor against the pending sign-in (package-internal): the failures so far, or `undefined` without one. The fifth drops it. */
export const RECORD_PENDING_FAILURE = Symbol('marmeon.auth.recordPendingFailure');

/**
 * Signs in an account whose passkey was just verified, without a password (package-internal, for the passkeys service): the passkey
 * with user verification is possession and inherence at once, so the session counts as having passed a second factor.
 */
export const SIGN_IN_VERIFIED = Symbol('marmeon.auth.signInVerified');

const DROP_EXPIRED = Symbol('marmeon.auth.dropExpired');

const SIGN_IN_VIA: readonly unknown[] = Object.keys({ attempt: true, app: true, remember: true, passkey: true } satisfies Record<SignInVia, true>);

/** Wrong second factors a pending sign-in survives: the fifth ends it, and the password has to be typed again. */
export const PENDING_MAX_FAILURES = 5;

/** What {@link READ_PENDING} hands out. */
export interface PendingView {
  readonly userId: AuthUserId;
  readonly factors: readonly SecondFactor[];
  readonly failures: number;
  readonly remember: boolean;
}

/** The way into the sign-in after the second factor — a package-internal key, so only `TwoFactor` can finish a pending sign-in. */
export const COMPLETE_PENDING = Symbol('marmeon.auth.completePending');

/**
 * Why `attempt()` did not sign anybody in. `two-factor-required` is no failure: the password was right, and the sign-in waits for a
 * factor (`auth.pendingSecondFactor()`). `throttled` checked nothing: `retryAfterSeconds` until the minute of this client and identifier
 * is free again, or, with `account: true`, the account's daily ceiling — then waiting does not help, the way out is a password reset or
 * a passkey.
 */
export type AttemptError =
  | { readonly kind: 'invalid-credentials' }
  | { readonly kind: 'two-factor-required'; readonly factors: readonly SecondFactor[] }
  | { readonly kind: 'throttled'; readonly retryAfterSeconds: number; readonly account?: true };

declare module '@marmeon/cache' {
  interface LimiterContext {
    /** The signed-in user, when `authenticate()` runs before `throttle()` on the route — else `undefined`. */
    readonly user?: AuthUser | undefined;
  }
}

export interface SignInOptions {
  /** Keeps this browser signed in for up to `AUTH_REMEMBER_DAYS` days without the password — a convenience, not a proof. See `docs/authentication.md#remember-me`. */
  readonly remember?: boolean;
  /**
   * The client's address for the `SignedIn` event (for "a new sign-in" notices, audit logs). Default: the request's (`ClientInfo`,
   * through `SERVER_TRUSTED_PROXIES` like `ctx.ip`) — pass it only to say something else.
   */
  readonly ip?: string | undefined;
  /** The browser's `User-Agent` header for the `SignedIn` event — default: the request's, like `ip`. */
  readonly userAgent?: string | undefined;
}

/** The longest a failed sign-in is padded to, whatever the hasher says. */
export const MAX_FLOOR_MS = 10_000;

/** What `Hasher.failureFloorMs()` answered, as the time to pad to: refused unless a finite number of 0 or more, and never above {@link MAX_FLOOR_MS}. */
export function paddedTo(floor: unknown): number {
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0) {
    throw new Error(withCode('A6', `Hasher.failureFloorMs() must answer a finite number of milliseconds, 0 or more; it answered ${String(floor)}.`));
  }
  // A hasher that counts seconds instead of milliseconds would hold every failed sign-in for minutes: a lever for anyone sending wrong passwords.
  return Math.min(floor, MAX_FLOOR_MS);
}

/**
 * Who is signed in — for this request (scoped, injected like the `Session`). The session guard of
 * the `web` group: sign in with `attempt`/`signIn`, out with `signOut`, ask with `user`/`check`/`id`.
 *
 * ```ts
 * const signedIn = await this.#auth.attempt(ctx.body.email, ctx.body.password, { remember: ctx.body.remember });
 * if (!signedIn.ok) throw new ValidationError({ email: ['These credentials do not match our records.'] });
 * ```
 */
export class Auth {
  readonly #session: Session;
  readonly #users: UserProvider;
  readonly #hasher: Hasher;
  readonly #events: EventDispatcher;
  readonly #cookies: CookieJar;
  readonly #config: AuthConfig;
  readonly #sessionConfig: SessionConfig;
  readonly #rememberCookie: string;
  readonly #logger: Logger;
  readonly #history: ClientHistory;
  readonly #request: ClientInfo;
  readonly #newPassword: NewPassword;
  readonly #twoFactor: TwoFactorState;
  readonly #accountSessions: AccountSessions;
  readonly #signIns: SignInStore;
  readonly #clock: Clock;
  readonly #limiter: RateLimiter;
  readonly #signInThrottle: SignInThrottle;
  #user: Promise<AuthUser | undefined> | undefined;
  /**
   * The credentials this request checked its session against (`#resolve`) or signed in with (`#completeSignIn`).
   * Invariant: a new fingerprint of this session is built from these, never from a fresh `findById()`. If somebody else changes the
   * account in between (`AccountSessions.end()`), the fingerprint no longer matches at the next request and the session ends; a fresh
   * read would bind it to the new state and let it survive.
   */
  #verified: Credentials | undefined;
  readonly #fingerprints: SessionFingerprints;

  /** @internal Built by the container. */
  constructor(
    session: Session,
    users: UserProvider,
    hasher: Hasher,
    events: EventDispatcher,
    cookies: CookieJar,
    config: AuthConfig,
    sessionConfig: SessionConfig,
    logger: Logger,
    history: ClientHistory,
    request: ClientInfo,
    newPassword: NewPassword,
    twoFactor: TwoFactorState,
    accountSessions: AccountSessions,
    signIns: SignInStore,
    clock: Clock,
    fingerprints: SessionFingerprints,
    limiter: RateLimiter,
    signInThrottle: SignInThrottle,
  ) {
    this.#limiter = limiter;
    this.#signInThrottle = signInThrottle;
    this.#fingerprints = fingerprints;
    this.#session = session;
    this.#users = users;
    this.#hasher = hasher;
    this.#events = events;
    this.#cookies = cookies;
    this.#config = config;
    this.#sessionConfig = sessionConfig;
    this.#rememberCookie = rememberCookieName(config, sessionConfig);
    this.#logger = logger;
    this.#history = history;
    this.#request = request;
    this.#newPassword = newPassword;
    this.#twoFactor = twoFactor;
    this.#accountSessions = accountSessions;
    this.#signIns = signIns;
    this.#clock = clock;
  }

  /**
   * Checks the credentials and signs the user in: `ok` with the user, or an `err` — `invalid-credentials`, or `two-factor-required`
   * when the password was right but the account has a second factor (see {@link TwoFactorState}). Then nobody is signed in: the
   * session waits for the factor (`pendingSecondFactor()`), and an app that does not handle that case shows a failed sign-in at worst.
   * See `docs/errors.md#results`. There is one kind for an unknown identifier, a wrong password and an
   * account without a password alike — in the same time (`dummyVerify`), so neither the answer nor its duration
   * tells which addresses have an account. Rehashes the password when the costs changed — only over the hash it verified (see `UserProvider.updatePasswordHash()`); a reset that landed meanwhile makes it `invalid-credentials`. Both `findForSignIn()` and `findById()` must
   * hand back `sessionKey` when the account has one; a provider that returns it from only one makes `attempt()` throw.
   */
  async attempt(identifier: string, password: string, options: SignInOptions = {}): Promise<Result<AuthUser, AttemptError>> {
    // A hasher without failureFloorMs() (JavaScript, a cast) would let the response time tell which addresses have an account.
    if (typeof this.#hasher.failureFloorMs !== 'function') {
      throw new Error(withCode('A6', 'The Hasher needs failureFloorMs(): the time a failed sign-in is padded to, in milliseconds (0 gives up the padding). See docs/hashing.md#making-and-checking-hashes.'));
    }
    assertSignInFinder(this.#users);
    const ip = options.ip ?? this.#request.ip;
    // Counted BEFORE anything is read or checked (see `SignInThrottle.takeClient()`).
    const wait = await this.#signInThrottle.takeClient(identifier, ip);
    if (wait !== undefined) {
      await this.#events.dispatch(new SignInLockedOut(identifier, ip, 'client'));
      return err({ kind: 'throttled', retryAfterSeconds: wait });
    }
    const started = performance.now();
    const found = await this.#users.findForSignIn(identifier);
    // The account's own ceiling, whichever clients the guesses come from, counted before the password is checked. Past it nothing is
    // checked — the right password included — and an unknown identifier gets the same answer and does the same work.
    // The one exception is the owner's own browser: a valid device cookie for exactly this account counts on a limit of its own instead.
    // A cookie that does not fit (none, forged, expired, of another account, from before a new key, or an unknown account) takes the
    // same path as no cookie, and the answer does not tell which it was.
    const device = found && this.#signInThrottle.deviceNonce(this.#cookies.get(this.#signInThrottle.deviceCookieName), found);
    const held = device !== undefined && (await this.#signInThrottle.takeDevice(device)) ? undefined : await this.#signInThrottle.takeAccount(identifier, found === undefined ? undefined : idOf(found.user));
    if (held !== undefined) {
      if (held.first) await this.#events.dispatch(new SignInLockedOut(identifier, ip, 'account'));
      // Padded like a wrong password: the refusal is no faster than a check, and an unknown account costs the same.
      await this.#padFailure(started);
      return err({ kind: 'throttled', retryAfterSeconds: held.retryAfterSeconds, account: true as const });
    }
    const credentials = await this.#check(identifier, password, found, started);
    if (!credentials) return err({ kind: 'invalid-credentials' });
    // The fingerprint from the account as findById() sees it — what every later request compares with (the session key included).
    const current = await this.#credentials(credentials.user);
    // Only what was verified is bound (see `#verified`). A reset, a password change or an ending (each writes a new key) that committed during the slow
    // check changed the account since; the request cannot tell that from a wrong password, and a new attempt checks the new state.
    if (!(await this.#sameAccount(identifier, credentials, current))) {
      await this.#events.dispatch(new SignInFailed(identifier, credentials.user));
      return err({ kind: 'invalid-credentials' });
    }
    // The password was right: the minute of this client starts over (the account's count is cleared by the sign-in, or below when a factor holds it).
    await this.#signInThrottle.clearClient(identifier, ip);
    // The one fork for every password sign-in: an account with a factor is never signed in here, whatever the caller does with the err.
    const factors = await this.#passwordSignIn(current, options, 'attempt');
    if (factors.length > 0) {
      await this.#signInThrottle.clearAccount(idOf(current.user));
      return err({ kind: 'two-factor-required', factors });
    }
    writeAuth(this.#session, 'confirmedAt', this.#now()); // the password was just typed
    writeAuth(this.#session, 'typedPassword', true);
    return ok(credentials.user);
  }

  /**
   * The device cookie for the signed-in user's browser, to set after `attempt()` signed it in with the password (`ctx.cookies.set(cookie.name,
   * cookie.value, cookie.options)`): it keeps the owner's browser past the account's daily ceiling of password sign-ins, on a limit of its
   * own. `undefined` when `AUTH_DEVICE_COOKIE_DAYS` is `0` or nobody is signed in. See `docs/authentication.md#limits-on-password-sign-ins`.
   */
  async deviceCookie(): Promise<DeviceCookie | undefined> {
    const user = await this.user();
    return user && this.#signInThrottle.issueDevice(await this.#credentials(user));
  }

  /**
   * Signs `user` in (after registration, say): new session id and CSRF token, fingerprint of the account's id and current session key. `'signed-in'`, or
   * `'two-factor-required'` for an account with a second factor — then nobody is signed in, exactly as with `attempt()`. For a new
   * authentication only: called in a request that is signed in already, it reads the account anew and binds the session to it.
   */
  async signIn(user: AuthUser, options: SignInOptions = {}): Promise<'signed-in' | 'two-factor-required'> {
    const factors = await this.#passwordSignIn(await this.#credentials(user), options, 'app');
    return factors.length > 0 ? 'two-factor-required' : 'signed-in';
  }

  /** The factors a sign-in waits for, or `undefined` when none waits (or it ran out). The waiting account is not signed in: `user()` is `undefined`. */
  pendingSecondFactor(): { readonly factors: readonly SecondFactor[] } | undefined {
    const pending = this.#pending();
    return pending === undefined ? undefined : { factors: pending.factors };
  }

  /**
   * @internal
   * The waiting sign-in, if it is still good: `undefined` without one, `'expired'` when it ran out or its account is gone or changed its
   * password or session key since the password step (it is dropped then). Checked here, before any factor is looked at.
   */
  async [READ_PENDING](): Promise<PendingView | 'expired' | undefined> {
    const pending = this.#pending();
    if (pending === undefined) return this.#session.started && this.#session.has(AUTH_SESSION_KEYS.pending) ? this[DROP_EXPIRED]() : undefined;
    const found = await this.#users.findById(pending.id as never);
    if (!found || !this.#fingerprints.matches(pending.fingerprint, found)) return this[DROP_EXPIRED]();
    return { userId: pending.id as AuthUserId, factors: pending.factors, failures: pending.failures, remember: pending.remember };
  }

  /** @internal */
  [DROP_EXPIRED](): 'expired' {
    this.#session.forget(AUTH_SESSION_KEYS.pending);
    return 'expired';
  }

  /** @internal */
  [RECORD_PENDING_FAILURE](): number | undefined {
    const pending = this.#pending();
    if (pending === undefined) return undefined;
    const failures = pending.failures + 1;
    if (failures >= PENDING_MAX_FAILURES) this.#session.forget(AUTH_SESSION_KEYS.pending);
    else writeAuth(this.#session, 'pending', { ...pending, failures });
    return failures;
  }

  /**
   * @internal
   * Finishes a pending sign-in after the second factor of `verifiedUserId` was proven — package-internal (`TwoFactor` calls it). Checks it
   * again: `no-challenge` without a pending sign-in, `expired` when it ran out, belongs to another account than the one that proved a
   * factor, or the account is gone or changed its password or session key since the password step (the pending state is dropped then).
   * Invariant: a factor proves the account it was checked for, never the one the session happens to wait for.
   */
  async [COMPLETE_PENDING](verifiedUserId: AuthUserId | string | number): Promise<Result<AuthUser, { readonly kind: 'no-challenge' } | { readonly kind: 'expired' }>> {
    const pending = this.#pending();
    if (pending === undefined) {
      const stale = this.#session.started && this.#session.has(AUTH_SESSION_KEYS.pending);
      if (stale) this.#session.forget(AUTH_SESSION_KEYS.pending);
      return err({ kind: stale ? 'expired' : 'no-challenge' });
    }
    this.#session.forget(AUTH_SESSION_KEYS.pending);
    if (String(pending.id) !== String(verifiedUserId)) return err({ kind: 'expired' });
    const found = await this.#users.findById(pending.id as never);
    if (!found || !this.#fingerprints.matches(pending.fingerprint, found)) return err({ kind: 'expired' });
    await (await this.#completeSignIn(found, { remember: pending.remember }, pending.via)).announce();
    // Only a typed password confirms, dated when it was typed. The sign-in starts then too, so the confirmation stays inside it (`passwordRecentlyConfirmed`).
    if (pending.via === 'attempt' && typeof pending.typedAt === 'number') {
      writeAuth(this.#session, 'signedInAt', pending.typedAt);
      writeAuth(this.#session, 'confirmedAt', pending.typedAt);
      writeAuth(this.#session, 'typedPassword', true);
    }
    writeAuth(this.#session, 'twoFactorAt', this.#now());
    return ok(found.user);
  }

  /**
   * @internal
   * Signs in `verifiedUserId`, whose passkey was just checked for a passwordless sign-in. New session id and CSRF token as at any sign-in; a
   * password sign-in that waits for a factor is dropped. `expired` when the account is gone. The password was not typed, so the session
   * counts as a fresh confirmation instead: the passkey with user verification is the proof `confirmedPassword()` asks for.
   * Invariant: the caller has proven a passkey of exactly this account, with user verification, a challenge used once.
   * `checkedAgainst` is the account as the caller read it before it verified the assertion: only that state is bound (see `#verified`).
   * A fresh read that no longer fits it — a reset, a new key or an ending landed meanwhile — is `expired`, as at `attempt()`.
   */
  async [SIGN_IN_VERIFIED](
    verifiedUserId: AuthUserId | string | number,
    options: { readonly remember?: boolean } = {},
    checkedAgainst?: Credentials,
  ): Promise<Result<AuthUser, { readonly kind: 'expired' }>> {
    const found = await this.#users.findById(verifiedUserId as never);
    if (!found) return err({ kind: 'expired' });
    if (checkedAgainst !== undefined && !this.#fingerprints.matches(this.#fingerprints.of(found), checkedAgainst)) return err({ kind: 'expired' });
    await (await this.#completeSignIn(checkedAgainst ?? found, { remember: options.remember === true }, 'passkey')).announce();
    writeAuth(this.#session, 'confirmedAt', this.#now());
    writeAuth(this.#session, 'twoFactorAt', this.#now());
    return ok(found.user);
  }

  /**
   * Signs out on this device: the session's data, id and CSRF token are all replaced, the remember-me token is dropped.
   * The browser loads the next page fully (its in-memory pages are gone) and clears the site's storage
   * (`Clear-Site-Data: "storage"`; signed-in answers are `no-store`, so the HTTP cache holds none of them) — see `ClientHistory`; an app that keeps something in
   * the browser's storage across a sign-out takes that back with `history.clear({ siteData: false })` after `signOut()`.
   */
  async signOut(): Promise<void> {
    const user = await this.user();
    const signIn = this.#ownSignIn();
    try {
      await this.#forgetDevice();
    } finally {
      // Signed out whatever the stores do: a failing store must not keep the user signed in.
      this.#session.invalidate();
      this.#history.clear({ siteData: ['storage'] });
      this.#user = Promise.resolve(undefined);
      this.#verified = undefined;
      // A token that could not be removed must not sign this browser in again: its cookie goes and so does its row (which ends the token).
      if (this.#cookies.get(this.#rememberCookie) !== undefined) this.#cookies.delete(this.#rememberCookie);
      await this.#endSignIn(signIn);
    }
    if (user) await this.#events.dispatch(new SignedOut(user));
  }

  /** The signed-in user — looked up once per request; from the session, else from the remember-me cookie. */
  user(): Promise<AuthUser | undefined> {
    this.#user ??= this.#resolve();
    return this.#user;
  }

  async check(): Promise<boolean> {
    return (await this.user()) !== undefined;
  }

  async id(): Promise<AuthUserId | undefined> {
    const user = await this.user();
    return user === undefined ? undefined : (idOf(user) as AuthUserId);
  }

  /** Whether this session was signed in by the remember-me cookie rather than a password. */
  viaRemember(): boolean {
    return this.#session.started && readAuth(this.#session, 'viaRemember') === true;
  }

  /**
   * Checks the signed-in user's password again (before sensitive actions) and, if right, notes the time for `confirmedPassword()`.
   * The check is counted before it is made, in one atomic step, per sign-in and per account (see `takePasswordCheck()`), and a right
   * password clears the sign-in's minute: a stolen session cannot guess the password at the speed of the hasher. `throttled` is
   * answered without hashing, also for the right password. An empty password is `invalid-password` and counts nothing: there is
   * nothing to guess. Takes as long when there is no password. A right password gives the session a new id (the data stays): an id
   * that leaked earlier does not reach the confirmation. Throws without a signed-in user.
   */
  async checkPassword(password: string): Promise<Result<void, PasswordCheckError>> {
    const user = await this.#requireUser('checkPassword');
    if (password === '') return err({ kind: 'invalid-password' });
    const scope = this.passwordCheckScope();
    const held = await takePasswordCheck(this.#limiter, scope, idOf(user));
    if (held !== undefined) return err(held);
    const credentials = await this.#current();
    const right = credentials?.passwordHash ? await this.#hasher.verify(password, credentials.passwordHash) : await this.#hasher.dummyVerify(password);
    if (!right) return err({ kind: 'invalid-password' });
    await clearPasswordCheck(this.#limiter, scope);
    // A session id leaked before the confirmation must not ride into the window it opens (`throttleKey` stays, so the counts do).
    this.#session.regenerate();
    writeAuth(this.#session, 'confirmedAt', this.#now());
    return ok();
  }

  /**
   * Whose password checks these are, for `takePasswordCheck()`: this sign-in's own key, and whether it began with a typed password.
   * A session without a key gets one now; on a read-only request it is counted under the session id, with the account's cap.
   * Throws without a started session: a password check needs a signed-in user.
   */
  passwordCheckScope(): PasswordCheckScope {
    if (!this.#session.started) throw new Error('auth.passwordCheckScope() needs a started session — a password check belongs to a signed-in user.');
    const stored = readAuth(this.#session, 'throttleKey');
    let key: string;
    if (typeof stored === 'string') key = stored;
    else {
      if (this.#session.readOnly) return { session: this.#session.id, typed: false };
      key = randomBytes(16).toString('base64url');
      writeAuth(this.#session, 'throttleKey', key);
    }
    return { session: key, typed: readAuth(this.#session, 'typedPassword') === true };
  }

  /** Whether a password was typed or a passkey proven (`passkeys.confirm()`, a passwordless sign-in) within `within`, a {@link Duration} (a number is seconds; default `AUTH_PASSWORD_TIMEOUT_SECONDS`). An invalid `within` throws; a missing or implausible confirmation time is `false`. */
  passwordRecentlyConfirmed(within?: Duration): boolean {
    const seconds = within === undefined ? this.#config.passwordTimeoutSeconds : durationToSeconds(within);
    const at = this.#session.started ? readAuth(this.#session, 'confirmedAt') : undefined;
    // A confirmation counts only inside the sign-in it was typed for: one dated before the sign-in began is not its own.
    const signedInAt = this.#session.started ? readAuth(this.#session, 'signedInAt') : undefined;
    const current = this.#now();
    // A time further in the future than the clock skew is no confirmation (a clock that moved back, a value that did not come from
    // here). An earlier sign-in cannot slip in through the skew before `signedInAt`, because `#completeSignIn` forgets `confirmedAt`.
    return (
      typeof at === 'number' &&
      Number.isFinite(at) &&
      at <= current + CLOCK_SKEW_SECONDS &&
      typeof signedInAt === 'number' &&
      Number.isFinite(signedInAt) &&
      at >= signedInAt - CLOCK_SKEW_SECONDS &&
      Math.max(0, current - at) < seconds
    );
  }

  /**
   * The browsers the signed-in user is signed in on, the current one first and marked `current`, then by last request. Only sign-ins
   * that are alive: within `SESSION_LIFETIME_MINUTES` and `AUTH_SESSION_MAX_HOURS`, or kept by a remember-me cookie. See
   * `docs/authentication.md#sign-ins`.
   */
  async signIns(): Promise<readonly SignIn[]> {
    const user = await this.#requireUser('signIns');
    const current = this.#ownSignIn()?.id;
    const records = await this.#signIns.list(idOf(user), { idleSeconds: this.#sessionConfig.lifetimeMinutes * 60, maxSeconds: this.#config.sessionMaxSeconds });
    const list = records.map((record): SignIn => ({
      id: record.id,
      current: record.id === current,
      remembered: record.remembered,
      signedInAt: record.signedInAt,
      lastSeenAt: record.lastSeenAt,
      createdAt: record.createdAt,
      userAgent: record.userAgent,
      device: describeDevice(record.userAgent),
    }));
    return [...list.filter((signIn) => signIn.current), ...list.filter((signIn) => !signIn.current)];
  }

  /**
   * Signs the user out of one of the browsers listed by `signIns()`: from its next request on, that browser is a guest, and its
   * remember-me cookie signs nobody in again. Only the user's own sign-ins can be ended — an id of anybody else's is `missing`, like
   * an unknown or malformed one. `current`: that is this browser's — end it with `signOut()`. Throws without a recent confirmation, a
   * password or a passkey (put the route behind `confirmedPassword()`): a stolen session cookie must not be able to sign its owner out
   * everywhere else.
   */
  async endSignIn(id: string): Promise<Result<void, { readonly kind: 'missing' } | { readonly kind: 'current' }>> {
    const user = await this.#requireUser('endSignIn');
    if (!this.passwordRecentlyConfirmed()) throw new Error('auth.endSignIn() needs a recent confirmation (a password or a passkey) — put the route behind confirmedPassword().');
    if (id === this.#ownSignIn()?.id) return err({ kind: 'current' });
    if (!(await this.#signIns.end(idOf(user), id))) return err({ kind: 'missing' });
    await this.#announceEnded(idOf(user));
    return ok(undefined);
  }

  /**
   * Sets a new password for the signed-in user, together with a new session key. Every other session ends (their fingerprint no
   * longer matches) and every remember-me token is dropped — this device's too; this session stays.
   * With `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`, every API token of the user is revoked in the transaction of the new hash.
   * Throws without a recent confirmation, a password or a passkey (put the route behind `confirmedPassword()`): a stolen session
   * cookie must not be able to take the account over by choosing a password.
   */
  async updatePassword(password: string): Promise<void> {
    const user = await this.#requireUser('updatePassword');
    if (!this.passwordRecentlyConfirmed()) throw new Error('auth.updatePassword() needs a recent confirmation (a password or a passkey) — put the route behind confirmedPassword().');
    const verified = this.#requireVerified();
    const hash = await this.#hasher.make(password);
    // The hash took its time: an `AccountSessions.end()` that landed meanwhile must not be written over — a session it ended stays ended.
    const stored = await this.#newPassword.store(this.#users, idOf(user), hash, 'change', undefined, verified.sessionKey ?? null, this.#ownSignIn()?.id).catch(async (error: unknown) => {
      if (!(error instanceof AccountClaimLost)) throw error;
      await this.#end();
      throw new Error('auth.updatePassword() needs a signed-in user — this session was ended while the password was changed.', { cause: error });
    });
    const { revoked, sessionKey } = stored;
    this.#cookies.delete(this.#rememberCookie);
    this.#anchor({ ...verified, passwordHash: hash, sessionKey });
    writeAuth(this.#session, 'confirmedAt', this.#now());
    await this.#endOtherSignIns(idOf(user), true); // after the key: the key is what ends the other sessions, the rows only leave the list
    await this.#events.dispatch(new PasswordChanged(user, revoked));
    await this.#announceEnded(idOf(user)); // last: this tab's new session is saved by the time its stream connects again
  }

  /**
   * Signs out every other device — after `checkPassword()` where the account has a password, or whenever the app
   * confirmed the user its own way (a link, OAuth): stores a new random session key (`UserProvider.updateSessionKey()`), so the other
   * sessions' fingerprints stop matching, and drops the other devices' remember-me tokens; this session stays. Throws when the
   * provider cannot store a key, or does not hand it back from `findById()` — it never pretends to have signed anybody out.
   * `false`: this session was ended meanwhile (another device or `AccountSessions.end()` replaced the key) — it is signed out now. Also `false` when this device's remember-me cookie turns out to be a copy
   * (its validator is stale: somebody else holds a newer one): then every token and session of the account is ended, like at a copied
   * cookie, and this device is signed out too.
   *
   * Does not ask for a recent confirmation, because the app may have confirmed the user its own way: call it after `checkPassword()` or
   * behind `confirmedPassword()`, or a stolen session cookie can sign its owner out everywhere else.
   */
  async updateSessionKey(): Promise<boolean> {
    const user = await this.#requireUser('updateSessionKey');
    const verified = this.#requireVerified();
    // The other sign-ins, tokens with them, before the key, for the same reason as at `AccountSessions.end()`; this device's stays.
    await this.#signIns.endAll(idOf(user), this.#ownSignIn()?.id);
    const rotated = await rotateSessionKey(this.#users, idOf(user), verified.sessionKey ?? null, 'auth.updateSessionKey()');
    if (rotated.kind === 'conflict') {
      // The key is not the one this request checked: this session is over, and so is this device's token.
      await this.#end();
      return false;
    }
    this.#anchor({ ...verified, sessionKey: rotated.key });
    if (!(await this.#rebindOwnToken())) return false; // this device's token stays, for the new state — unless it is a copy
    await this.#endOtherSignIns(idOf(user), false); // after the key, see updatePassword()
    await this.#announceEnded(idOf(user));
    return true;
  }

  /** @internal */
  async [DROP_REMEMBER_TOKEN](): Promise<void> {
    const own = this.#ownSignIn();
    if (own !== undefined) await this.#signIns.dropToken(own.userId, own.id);
  }

  /**
   * @internal
   * Whether this session still fits the account, decided inside the transaction that stores a factor: `false` means it ended meanwhile
   * (`AccountSessions.end()`, a password change or a key rotation elsewhere) and the caller rolls back. It ends nothing itself — the
   * caller runs `ACCOUNT_STILL_CLAIMED` after the rollback, so that dropping the device's remember-me token is not rolled back too.
   * Invariant: a factor stays only while the session still fits the account. With an account that has a session key, the same-key compare-and-set takes the row's lock until the commit (on the connection of the
   * transaction), so an ending cannot land between this check and the factor. A `null` key is never rotated and cannot be locked
   * (a rotation would sign the other devices out). Every ending writes the account's row (the key, which every new password writes too, or the row itself), so a
   * fresh read sees each ending that committed before it.
   */
  async [CLAIM_ACCOUNT](): Promise<boolean> {
    const verified = this.#requireVerified();
    if (typeof verified.sessionKey === 'string') {
      // A provider without the method (JavaScript, a cast) would skip the lock without a word: refuse it.
      if (typeof this.#users.updateSessionKey !== 'function') throw missingSessionKeyMethod('Auth');
      // The same key, compare-and-set: writes nothing new, but takes the row's lock until the commit.
      const held: unknown = await this.#users.updateSessionKey(idOf(verified.user) as never, verified.sessionKey, verified.sessionKey);
      if (typeof held !== 'boolean') throw notABoolean('Auth');
      if (!held) return false;
    }
    return this.#fits(verified);
  }

  /** @internal */
  [VERIFIED_SESSION_KEY](): string | null {
    return this.#requireVerified().sessionKey ?? null;
  }

  /**
   * @internal
   * The check of `CLAIM_ACCOUNT` without a lock: the whole fingerprint (id and key) is read afresh, the row too, and a session that no longer fits
   * is signed out (outside any transaction, so it stays ended). Callers run it after the factor is committed — it also covers an
   * account without a session key and a provider whose compare-and-set takes no lock for this transaction — and after a rollback
   * that `CLAIM_ACCOUNT` asked for. `false`: the session ended meanwhile.
   */
  async [ACCOUNT_STILL_CLAIMED](): Promise<boolean> {
    if (await this.#fits(this.#requireVerified())) return true;
    await this.#end();
    return false;
  }

  /**
   * Whether the account is still what `findForSignIn()` verified: `false` for a real change (the session key) during the check. Throws when
   * the provider hands the session key back from only one of `findForSignIn()` and `findById()` — that is the provider's contract, not a race.
   */
  async #sameAccount(identifier: string, credentials: Credentials, current: Credentials): Promise<boolean> {
    const contract = (missing: string, has: string) =>
      new Error(
        withCode(
          'A5',
          `auth: ${this.#users.constructor.name}.${missing}() returned no sessionKey, but ${has}() returns one for this account. ` +
            'Hand the stored key back from both methods (see docs/authentication.md#the-user-type-and-where-users-come-from).',
        ),
      );
    if (credentials.sessionKey != null && current.sessionKey === undefined) throw contract('findById', 'findForSignIn');
    if (credentials.sessionKey === undefined && current.sessionKey != null) {
      // A key that appeared during the check is a race (a mismatch); a provider that still omits it on a second read breaks its contract.
      const again = await this.#users.findForSignIn(identifier);
      if (again !== undefined && again.sessionKey === undefined) throw contract('findForSignIn', 'findById');
    }
    return this.#fingerprints.matches(this.#fingerprints.of(current), credentials);
  }

  async #fits(verified: Credentials): Promise<boolean> {
    const found = await this.#users.findById(idOf(verified.user) as never);
    return found !== undefined && this.#fingerprints.matches(this.#fingerprints.of(found), verified);
  }

  /**
   * Tells the live streams of the account that some of its sign-ins ended: they close and the browsers still signed in connect again
   * (this one included — it is checked and stays). After the commit of the request's transaction, so a reconnecting stream cannot read
   * the old key; a failure is logged by `AccountSessions`, never thrown.
   */
  async #announceEnded(userId: AuthUserId): Promise<void> {
    await afterCommit(() => this.#accountSessions[ANNOUNCE_ENDED](userId));
  }

  /**
   * Deletes the rows of the user's other sign-ins (the other devices were signed out by the caller's new key already; this takes
   * them off the list). `ownTokenGone`: the caller dropped this device's remember-me token too, so this row stops claiming one.
   */
  async #endOtherSignIns(userId: AuthUserId, ownTokenGone: boolean): Promise<void> {
    const own = this.#ownSignIn();
    // Clean-up after the real effect (the new key is stored): a failing store is logged, never turned into a failed password change.
    try {
      await this.#signIns.endAll(userId, own?.id);
      if (ownTokenGone && own !== undefined) await this.#signIns.dropToken(userId, own.id);
    } catch (error) {
      this.#logger.error('The sign-in rows of the other devices could not be ended', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Ends this session and this device's remember-me token, as `signOut()` does without the event. */
  async #end(): Promise<void> {
    const signIn = this.#ownSignIn();
    try {
      await this.#forgetDevice();
    } finally {
      // Signed out whatever the stores do: a failing store must not keep the user signed in.
      this.#session.invalidate();
      this.#user = Promise.resolve(undefined);
      this.#verified = undefined;
      // A token that could not be removed must not sign this browser in again: its cookie goes and so does its row (which ends the token).
      if (this.#cookies.get(this.#rememberCookie) !== undefined) this.#cookies.delete(this.#rememberCookie);
      await this.#endSignIn(signIn);
    }
  }

  /** Binds this session to `credentials`, which are built from what this request verified and wrote itself (see `#verified`). */
  #anchor(credentials: Credentials): void {
    writeAuth(this.#session, 'password', this.#fingerprints.of(credentials));
    this.#verified = credentials;
  }

  /**
   * Stamps the remember-me token of this device with the state this request just wrote, so that it fits the account it stays for.
   * Invariant: only a cookie that carries the row's validator is kept. A stale validator means the token was rotated by somebody else
   * (a copy): the theft path runs as at `consume()`, no token is kept and this device is signed out. `false` then.
   */
  async #rebindOwnToken(): Promise<boolean> {
    const cookie = this.#cookies.get(this.#rememberCookie);
    if (cookie === undefined) return true;
    const verified = this.#requireVerified();
    const result = await this.#signIns.rebind(idOf(verified.user), cookie, this.#fingerprints.of(verified));
    if (result.ok) return true;
    if (result.error.kind === 'invalid') {
      this.#cookies.delete(this.#rememberCookie); // no row to keep: the cookie is of no use
      return true;
    }
    this.#logger.warn('A rotated remember-me token was presented again while signing out other devices: all remember-me tokens and sessions of the user are being ended', {
      user: result.error.userId,
      ip: this.#request.ip,
      userAgent: this.#request.userAgent?.slice(0, MAX_USER_AGENT),
    });
    this.#cookies.delete(this.#rememberCookie);
    await this.#endSessionsOfThief(result.error.userId, { ip: this.#request.ip, userAgent: this.#request.userAgent?.slice(0, MAX_USER_AGENT) });
    await this.#end();
    return false;
  }

  #requireVerified(): Credentials {
    if (this.#verified === undefined) throw new Error('auth: this request has no verified sign-in to change.');
    return this.#verified;
  }

  /**
   * Waits out what is left of `failureFloorMs()`, so a failed sign-in answers no faster than a check over the slowest hash
   * parameters this process has verified. A parameter set it has not verified yet (after a restart, on another node) is not known.
   */
  async #padFailure(started: number): Promise<undefined> {
    const left = paddedTo(await this.#hasher.failureFloorMs()) - (performance.now() - started);
    if (left > 0) await sleep(left); // real time, not the app Clock: waiting costs no CPU
    return undefined;
  }

  async #check(identifier: string, password: string, found: Credentials | undefined, started: number): Promise<Credentials | undefined> {
    if (!found || found.passwordHash === null) {
      await this.#hasher.dummyVerify(password);
      await this.#events.dispatch(new SignInFailed(identifier, found?.user));
      return this.#padFailure(started);
    }
    if (!(await this.#hasher.verify(password, found.passwordHash))) {
      await this.#events.dispatch(new SignInFailed(identifier, found.user));
      return this.#padFailure(started);
    }
    if (!this.#hasher.needsRehash(found.passwordHash)) return found;
    const passwordHash = await this.#hasher.make(password);
    // Only over the hash that was verified: a reset that landed during the slow check stays. The sign-in is then refused like a wrong
    // password (without a `SignInFailed` event); the next attempt checks the new state.
    if (!passwordHashWritten(await this.#users.updatePasswordHash(idOf(found.user) as never, passwordHash, { expected: found.passwordHash }), 'auth.attempt()')) return undefined;
    return { ...found, passwordHash };
  }

  /**
   * The fork of every password sign-in: the factors are read, an account with one is held back (`#hold`); else it is signed in. The
   * factors are read once more when the session and the remember-me token exist: a factor switched on in between (the commit of
   * `TwoFactor.confirm()` landing meanwhile) takes the sign-in back, token and cookie included. The factors that hold it, else none.
   */
  async #passwordSignIn(credentials: Credentials, options: SignInOptions, via: SignInVia): Promise<readonly SecondFactor[]> {
    const id = idOf(credentials.user);
    const factors = await this.#twoFactor.factors(id);
    if (factors.length > 0) {
      await this.#hold(credentials, factors, options, via);
      return factors;
    }
    const signedIn = await this.#completeSignIn(credentials, options, via);
    try {
      const after = await this.#twoFactor.factors(id);
      if (after.length === 0) {
        await signedIn.announce(); // only a sign-in that stays is announced: no listener sees one that is taken back
        return [];
      }
      // Taken back first, synchronously, then the token is forgotten: whatever fails later, nobody stays signed in.
      await this.#hold(credentials, after, options, via); // also ends the row the sign-in just made
      this.#cookies.delete(this.#rememberCookie);
      if (signedIn.token !== undefined) await this.#signIns.forgetToken(signedIn.token);
      return after;
    } catch (error) {
      // Fail closed: an error here (the second read of the factors, the removal of the token) must not leave the sign-in standing.
      this.#session.forget(AUTH_SESSION_KEYS.id, AUTH_SESSION_KEYS.password, AUTH_SESSION_KEYS.confirmedAt, AUTH_SESSION_KEYS.viaRemember, AUTH_SESSION_KEYS.twoFactorAt, AUTH_SESSION_KEYS.signedInAt, AUTH_SESSION_KEYS.rememberUntil, AUTH_SESSION_KEYS.signIn, AUTH_SESSION_KEYS.throttleKey, AUTH_SESSION_KEYS.typedPassword);
      this.#user = Promise.resolve(undefined);
      this.#verified = undefined;
      this.#cookies.delete(this.#rememberCookie);
      await this.#signIns.end(idOf(credentials.user), signedIn.signIn).catch(() => undefined);
      // A token that cannot be removed now is refused later by its date, once the factor is committed (`enabledSince`).
      if (signedIn.token !== undefined) await this.#signIns.forgetToken(signedIn.token).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Signs in. The remember-me token it made, if any (the cookie value), the sign-in's row, and `announce()`, which dispatches the `SignedIn`
   * event — the caller's to call once the sign-in stands. `resumed`: the row of the remember-me token that signs in, which continues.
   */
  async #completeSignIn(
    credentials: Credentials,
    { remember = false, ip = this.#request.ip, userAgent = this.#request.userAgent }: SignInOptions,
    via: SignInVia,
    rememberUntil?: number,
    resumed?: string,
  ): Promise<{ readonly token: string | undefined; readonly signIn: string; announce(): Promise<void> }> {
    const { user } = credentials;
    const viaRemember = via === 'remember';
    const previous = this.#ownSignIn(); // the row of the sign-in this one replaces
    // The writes that can fail come first, before the session says anything: a store that throws leaves no half sign-in behind
    // (the session is saved even when the request fails, and a signed-in session without a row would be given one lazily).
    // One token per device, and a guest carrying the cookie of another sign-in must not end up with two live rows: the cookie's row
    // goes (and the row of another user's token with it, a shared browser's: the cookie is replaced or removed below either way).
    if (!viaRemember) await this.#forgetDevice();
    // The row first, then its token: a token never exists without the row that is its authority.
    const signIn = resumed ?? (await this.#signIns.create({ userId: idOf(user), userAgent }));
    let token: string | undefined;
    let expiresAt: Date | undefined;
    // The app may have turned remember-me off while a form still sends the value: the sign-in stands, without a token.
    if (remember && !viaRemember && this.#config.remember) {
      expiresAt = new Date(this.#clock.now() + this.#config.rememberDays * 86_400_000);
      try {
        // Stamped with the fingerprint that was verified, never a fresh read: if the account changed since, the token no longer fits it
        // and `#fromRememberCookie` refuses it at its first use.
        token = await this.#signIns.issueToken(idOf(user), signIn, { until: expiresAt, fingerprint: this.#fingerprints.of(credentials) });
      } catch (error) {
        await this.#signIns.end(idOf(user), signIn).catch(() => undefined);
        throw error;
      }
    }
    // A session id (and CSRF token) handed out before sign-in must not survive it: session fixation.
    this.#session.regenerate();
    this.#session.forget(AUTH_SESSION_KEYS.pending);
    this.#session.forget(AUTH_SESSION_KEYS.twoFactorAt);
    // A confirmation belongs to the account that was signed in when it was typed; whoever types now (`attempt()`, or the factor of an `attempt()`) sets it again.
    this.#session.forget(AUTH_SESSION_KEYS.confirmedAt);
    // A new sign-in counts its password checks anew, and has typed no password until `attempt()` says so.
    this.#session.forget(AUTH_SESSION_KEYS.typedPassword);
    writeAuth(this.#session, 'throttleKey', randomBytes(16).toString('base64url'));
    writeAuth(this.#session, 'id', idOf(user));
    this.#anchor(credentials); // from what the caller read just now: the rule at `#verified` holds
    writeAuth(this.#session, 'signedInAt', this.#now());
    if (viaRemember) writeAuth(this.#session, 'viaRemember', true);
    else this.#session.forget(AUTH_SESSION_KEYS.viaRemember);
    if (viaRemember && rememberUntil !== undefined) writeAuth(this.#session, 'rememberUntil', rememberUntil);
    else this.#session.forget(AUTH_SESSION_KEYS.rememberUntil);
    if (token !== undefined && expiresAt !== undefined) this.#setCookie(token, expiresAt);
    writeAuth(this.#session, 'signIn', signIn);
    this.#user = Promise.resolve(user);
    // Another person may sit at this browser now: pages kept from before the sign-in must not come back.
    // (A remember-me sign-in continues the same person's session — no reload for that.)
    if (!viaRemember) this.#history.clear();
    if (previous && previous.id !== signIn) await this.#endSignIn(previous); // a sign-in over a sign-in leaves no orphan
    // The owner is in (their password, a passkey or a second factor): the account's count and notice start over. A remember-me cookie is not that proof.
    if (!viaRemember) await this.#signInThrottle.clearAccount(idOf(user));
    const at = new Date(this.#clock.now());
    return { token, signIn, announce: () => this.#events.dispatch(new SignedIn(user, { remember: token !== undefined || viaRemember, via, ip, userAgent }, at)) };
  }

  /**
   * Parks a correct password: a new session id (as at sign-in), every sign-in key gone, only {@link PendingSecondFactor} left.
   * Invariant: no `SignedIn` event, no remember-me token or cookie, no `_auth_id` — the account is not signed in until a factor is proven.
   */
  async #hold(credentials: Credentials, factors: readonly SecondFactor[], { remember = false }: SignInOptions, via: SignInVia): Promise<void> {
    const previous = this.#ownSignIn();
    this.#session.regenerate();
    for (const key of [AUTH_SESSION_KEYS.id, AUTH_SESSION_KEYS.password, AUTH_SESSION_KEYS.confirmedAt, AUTH_SESSION_KEYS.viaRemember, AUTH_SESSION_KEYS.twoFactorAt, AUTH_SESSION_KEYS.signedInAt, AUTH_SESSION_KEYS.rememberUntil, AUTH_SESSION_KEYS.signIn, AUTH_SESSION_KEYS.throttleKey, AUTH_SESSION_KEYS.typedPassword] as const) {
      this.#session.forget(key);
    }
    writeAuth(this.#session, 'pending', {
      id: idOf(credentials.user),
      fingerprint: this.#fingerprints.of(credentials),
      remember,
      via,
      ...(via === 'attempt' ? { typedAt: this.#now() } : {}),
      until: this.#now() + PENDING_SECONDS,
      failures: 0,
      factors,
    });
    this.#user = Promise.resolve(undefined);
    this.#verified = undefined;
    // Pages of the person before may still be in the browser; the next person is at the keyboard (as at sign-in).
    this.#history.clear();
    // Everything above ran before the first await: the session is held back whatever the store does.
    await this.#endSignIn(previous);
  }

  /** The pending sign-in if it is well-formed and has not run out; anything else counts as none. */
  #pending(): PendingSecondFactor | undefined {
    if (!this.#session.started) return undefined;
    const pending = readAuth(this.#session, 'pending') as Partial<Record<keyof PendingSecondFactor, unknown>> | null | undefined;
    if (typeof pending !== 'object' || pending === null || typeof pending.until !== 'number' || pending.until <= this.#now()) return undefined;
    if (!Array.isArray(pending.factors) || typeof pending.fingerprint !== 'string') return undefined;
    // A wait that an earlier release began (`via: 'login'`) is not read: the user signs in again, as for any other unreadable wait.
    if (!SIGN_IN_VIA.includes(pending.via)) return undefined;
    return pending as unknown as PendingSecondFactor;
  }

  async #resolve(): Promise<AuthUser | undefined> {
    if (!this.#session.started) return undefined; // the stateless `api` group has no session
    const id = readAuth(this.#session, 'id');
    if (id === undefined) return this.#fromRememberCookie();
    const found = await this.#users.findById(id as never);
    const fingerprint = readAuth(this.#session, 'password');
    if (!found || !this.#fingerprints.matches(fingerprint, found)) {
      // Deleted, or the session key changed since this session signed in (a new password writes one): this session ends — by the next request that may
      // write it (an island's is read-only: for it, nobody is signed in).
      if (!this.#session.readOnly) this.#session.invalidate();
      return undefined;
    }
    const signedInAt = readAuth(this.#session, 'signedInAt');
    // Invariant: a sign-in ends at most `AUTH_SESSION_MAX_HOURS` after it began, however active; after that only a still-valid
    // remember-me cookie signs in again, and `AUTH_REMEMBER_DAYS` bounds that. Unreadable times end it too (fail closed).
    if (this.#lifetimeOver(signedInAt)) {
      if (this.#session.readOnly) return undefined;
      this.#session.invalidate();
      return this.#fromRememberCookie();
    }
    // A session from before the lifetime was kept: its clock starts now, so a deploy signs nobody out.
    // A confirmation it holds is dated outside that sign-in, so it goes (the clock skew would otherwise let one just before count).
    if (signedInAt === undefined && !this.#session.readOnly) {
      this.#session.forget(AUTH_SESSION_KEYS.confirmedAt, AUTH_SESSION_KEYS.typedPassword);
      writeAuth(this.#session, 'signedInAt', this.#now());
    }
    // Invariant: the row in the store is the authority over a sign-in. A session whose row is gone — ended from another device, by
    // the user's list or by `prune` — is over, whatever the session driver still holds; its remember-me cookie hangs on the same row.
    const signIn = readAuth(this.#session, 'signIn');
    if (signIn === undefined) {
      // A session made without a row (`actingAs()` in a test, a session that predates the rows): its row is made now. Only a session
      // without a key gets one — a session whose row was ended has the key and takes the branch below.
      if (!this.#session.readOnly) {
        writeAuth(this.#session, 'signIn', await this.#signIns.create({ userId: idOf(found.user), userAgent: this.#request.userAgent }));
      }
    } else if (typeof signIn !== 'string' || !(await this.#signIns.seen(idOf(found.user), signIn, !this.#session.readOnly))) {
      if (this.#session.readOnly) return undefined;
      this.#session.invalidate();
      return this.#fromRememberCookie();
    }
    this.#verified = found;
    return found.user;
  }

  /**
   * A rotated validator coming back means two browsers hold one cookie, and the one that used it first already has a session:
   * deleting the tokens would leave that session signed in. `consume()` runs in the request's transaction when there is one, and
   * its deletes hold row locks there, so `end()` (which must run outside a transaction) runs once that transaction has finished,
   * committed or rolled back: a rollback brings the deleted tokens back, and `end()` deletes them again. Never throws (a provider
   * without a session key, say): this request is a guest anyway, and the error reaches the log.
   */
  async #endSessionsOfThief(userId: AuthUserId, details: { readonly ip?: string | undefined; readonly userAgent?: string | undefined }): Promise<void> {
    const end = async () => {
      let sessionsEnded = false;
      try {
        sessionsEnded = (await this.#accountSessions.end(userId as AuthUserId)).ok;
      } catch (error) {
        this.#logger.error('A rotated remember-me token was used again, but the sessions of the user could not be ended', {
          user: userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      let tokensGone = sessionsEnded;
      if (!sessionsEnded) {
        // After a rollback the tokens are back, and `end()` did not take them again: without this every replay would find them.
        try {
          await this.#signIns.endAll(userId as AuthUserId);
          tokensGone = true;
        } catch (error) {
          this.#logger.error('A rotated remember-me token was used again, but the remember-me tokens of the user could not be deleted', {
            user: userId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // Announced only once the tokens are gone: a replay would find them and repeat the event.
      if (tokensGone) await this.#announceReuse(userId, { ...details, sessionsEnded });
    };
    await afterRollback(end);
    await afterCommit(end);
  }

  /** Dispatches `RememberTokenReused` for an account that still exists; a failing listener is logged, never thrown (the request is a guest anyway). */
  async #announceReuse(userId: AuthUserId, details: { readonly ip?: string | undefined; readonly userAgent?: string | undefined; readonly sessionsEnded: boolean }): Promise<void> {
    try {
      const found = await this.#users.findById(userId as never);
      if (found) await this.#events.dispatch(new RememberTokenReused(found.user, details, new Date()));
    } catch (error) {
      this.#logger.error('A rotated remember-me token was used again, but the event could not be dispatched', {
        user: userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Whether the sign-in is over: past its maximum, dated in the future (beyond {@link CLOCK_SKEW_SECONDS}, for servers whose clocks
   * differ), its remember-me token over, or any of those times unreadable. A missing sign-in time is no end (see the caller).
   */
  #lifetimeOver(signedInAt: unknown): boolean {
    const at = this.#now();
    if (signedInAt !== undefined) {
      if (typeof signedInAt !== 'number' || !Number.isFinite(signedInAt) || signedInAt > at + CLOCK_SKEW_SECONDS || at - signedInAt >= this.#config.sessionMaxSeconds) return true;
    }
    const until = readAuth(this.#session, 'rememberUntil');
    return until !== undefined && (typeof until !== 'number' || !Number.isFinite(until) || until <= at);
  }

  async #fromRememberCookie(): Promise<AuthUser | undefined> {
    const cookie = this.#cookies.get(this.#rememberCookie);
    // A read-only request (an island) cannot sign in: consuming the token rotates it, and the new one would never
    // reach the browser (the next request would present the old one — "stolen"). The page's request signs in.
    if (!cookie || this.#session.readOnly) return undefined;
    // Remember-me is off: no cookie signs in, and its token goes (a lower `AUTH_REMEMBER_DAYS` ends what a higher one issued).
    if (!this.#config.remember) {
      await this.#signIns.forgetToken(cookie);
      this.#cookies.delete(this.#rememberCookie);
      return undefined;
    }
    const result = await this.#signIns.consume(cookie);
    if (!result.ok) {
      this.#cookies.delete(this.#rememberCookie);
      if (result.error.kind === 'stolen') {
        this.#logger.warn('A rotated remember-me token was used again: all remember-me tokens and sessions of the user are being ended', {
          user: result.error.userId,
          ip: this.#request.ip,
          userAgent: this.#request.userAgent?.slice(0, MAX_USER_AGENT),
        });
        await this.#endSessionsOfThief(result.error.userId, { ip: this.#request.ip, userAgent: this.#request.userAgent?.slice(0, MAX_USER_AGENT) });
      }
      return undefined;
    }
    const device = result.value;
    const current = device.cookie ?? cookie;
    // The token is refused whole: its sign-in goes with it, so a refused cookie leaves no row that is listed as kept signed in.
    const refuse = async (): Promise<undefined> => {
      await this.#signIns.forgetToken(current);
      this.#cookies.delete(this.#rememberCookie);
      return undefined;
    };
    const found = await this.#users.findById(device.userId as never);
    if (!found) return refuse();
    // Invariant: a token signs in only the account state it was issued under (the fingerprint sessions are bound to as well). A token
    // made before a reset, a new password or an ending, or one without a fingerprint, is refused whatever the order of those writes was;
    // it is never re-bound to the account's present key.
    if (device.fingerprint == null || !this.#fingerprints.matches(device.fingerprint, found)) return refuse();
    // Refused: a token made before the account's second factor existed (it proved none; a sign-in racing the activation can make one),
    // one past `AUTH_REMEMBER_DAYS` from its creation (also when issued under a longer setting), and any with an unreadable time
    // (an Invalid Date compares false with everything) — never taken as "after" or "not yet over".
    const since = await this.#twoFactor.enabledSince(idOf(found.user));
    const madeAt = device.createdAt?.getTime();
    const cap = Number.isFinite(madeAt) ? madeAt! + this.#config.rememberDays * 86_400_000 : Number.NaN;
    const expired = !(cap > this.#clock.now()) || !Number.isFinite(device.expiresAt.getTime());
    const refused = expired || (since !== undefined && !(madeAt! > since.getTime()));
    if (refused) return refuse();
    // A token that `AccountSessions.end()` deleted meanwhile is gone here (the fingerprint above covers the key it replaced).
    if (!(await this.#signIns.remembered(current))) {
      this.#cookies.delete(this.#rememberCookie);
      return undefined;
    }
    const until = Math.min(device.expiresAt.getTime(), cap);
    if (device.cookie) this.#setCookie(device.cookie, new Date(until));
    // The sign-in continues the row of its token: one browser, one entry.
    await (await this.#completeSignIn(found, {}, 'remember', Math.floor(until / 1000), device.signIn)).announce();
    // Every token of an account with a factor was made on a device that proved it (tokens made before the factor existed are dropped
    // when it is turned on), so this device has proven it too — at the time the token was made, which rotation keeps: a stolen cookie
    // does not turn into a fresh proof for the middleware's `maxAge`.
    if ((await this.#twoFactor.factors(idOf(found.user))).length > 0) writeAuth(this.#session, 'twoFactorAt', Math.floor(madeAt! / 1000));
    return found.user;
  }

  /** The row of this session's sign-in, with the user it belongs to — `undefined` without a started session, a user or a row. */
  #ownSignIn(): { readonly userId: AuthUserId; readonly id: string } | undefined {
    if (!this.#session.started) return undefined;
    const userId = readAuth(this.#session, 'id');
    const id = readAuth(this.#session, 'signIn');
    return userId === undefined || typeof id !== 'string' ? undefined : { userId: userId as AuthUserId, id };
  }

  async #endSignIn(signIn: { readonly userId: AuthUserId; readonly id: string } | undefined): Promise<void> {
    if (signIn === undefined) return;
    // Clean-up only: the sign-in it belonged to is over or replaced already, so a store that fails here leaves a row that `prune` removes.
    await this.#signIns.end(signIn.userId, signIn.id).catch((error: unknown) => {
      this.#logger.error('A sign-in row could not be ended', { error: error instanceof Error ? error.message : String(error) });
    });
  }

  async #forgetDevice(): Promise<void> {
    const cookie = this.#cookies.get(this.#rememberCookie);
    if (cookie) await this.#signIns.forgetToken(cookie);
    if (cookie !== undefined) this.#cookies.delete(this.#rememberCookie);
  }

  #setCookie(value: string, expiresAt: Date): void {
    const { secure, sameSite } = this.#sessionConfig;
    const left = Math.floor((expiresAt.getTime() - this.#clock.now()) / 1000);
    const maxAge = Number.isFinite(left) ? Math.max(0, left) : 0;
    this.#cookies.set(this.#rememberCookie, value, { httpOnly: true, secure, sameSite, maxAge });
  }

  #now(): number {
    return Math.floor(this.#clock.now() / 1000);
  }

  async #current(): Promise<Credentials | undefined> {
    const user = await this.user();
    return user === undefined ? undefined : this.#users.findById(idOf(user) as never);
  }

  async #credentials(user: AuthUser): Promise<Credentials> {
    const credentials = await this.#users.findById(idOf(user) as never);
    if (!credentials) throw new Error(`Cannot sign in user ${idOf(user)}: the UserProvider does not find them.`);
    return credentials;
  }

  async #requireUser(method: string): Promise<AuthUser> {
    const user = await this.user();
    if (!user) throw new Error(`auth.${method}() needs a signed-in user — put the route behind authenticate().`);
    return user;
  }
}

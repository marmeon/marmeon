import { hash as oneShotHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { err, EventDispatcher, Logger, ok, type Result } from '@marmeon/core';
import { ClientHistory, RequestInfo } from '@marmeon/http';
import { CookieJar } from '@marmeon/router';
import { Session, SESSION_USER_KEY, SessionConfig } from '@marmeon/session';
import { AuthConfig } from './config.ts';
import { Failed, Login, Logout, PasswordChanged, type LoginVia } from './events.ts';
import { Hasher } from './hashing.ts';
import { NewPassword } from './new-password.ts';
import { RememberTokenStore } from './remember.ts';
import { TwoFactorState, type SecondFactor } from './two-factor/state.ts';
import { idOf, UserProvider, type AuthUser, type AuthUserId, type Credentials } from './user.ts';
// An optional peer: it only types a rate limiter's `ctx.user` (below) where the app has the cache — nothing of it is loaded.
import type {} from '@marmeon/cache';

/** Session keys of the signed-in user — `_`-prefixed: framework bookkeeping, left out of `session.all()`. */
export const AUTH_SESSION_KEYS = {
  /** The user's id (the session package's key: the `database` session driver copies it into `user_id`). */
  id: SESSION_USER_KEY,
  /** The account's fingerprint when the session signed in: its id, password hash and session key. */
  password: '_auth_password',
  /** When the password was last typed (sign-in, confirmation), in Unix seconds — for `confirmedPassword()`. */
  confirmedAt: '_auth_confirmed_at',
  /** Signed in by the remember-me cookie, not by a password. */
  viaRemember: '_auth_via_remember',
  /** A correct password whose account still owes a second factor — not a sign-in (see {@link PendingSecondFactor}). */
  pending: '_auth_pending',
  /** When this session proved a second factor, in Unix seconds — for the middleware that asks for one. */
  twoFactorAt: '_auth_two_factor_at',
} as const;

/** How long a correct password waits for the second factor, in seconds. */
export const PENDING_SECONDS = 300;

/**
 * What the session keeps between the password and the second factor. It names the account, but nothing in the session
 * signs anybody in until {@link COMPLETE_PENDING} has checked it again.
 */
export interface PendingSecondFactor {
  readonly id: string | number;
  /** The account's fingerprint at the password step: a new password or session key in between ends the wait. */
  readonly fingerprint: string;
  readonly remember: boolean;
  readonly via: LoginVia;
  /** Unix seconds. */
  readonly until: number;
  readonly failures: number;
  readonly factors: readonly SecondFactor[];
}

/** Reads the pending state (package-internal, for `TwoFactor`): the account it names, and how often a factor failed. `undefined` when none waits or it ran out. */
export const READ_PENDING = Symbol('marmeon.auth.readPending');

/** What {@link READ_PENDING} hands out. */
export interface PendingView {
  readonly userId: string | number;
  readonly factors: readonly SecondFactor[];
  readonly failures: number;
  readonly remember: boolean;
}

/** The way into the sign-in after the second factor — a package-internal key, so only `TwoFactor` can finish a pending sign-in. */
export const COMPLETE_PENDING = Symbol('marmeon.auth.completePending');

/** Why `attempt()` did not sign anybody in. `two-factor-required` is no failure: the password was right, and the sign-in waits for a factor (`auth.pendingSecondFactor()`). */
export type AttemptError = { readonly kind: 'invalid-credentials' } | { readonly kind: 'two-factor-required'; readonly factors: readonly SecondFactor[] };

declare module '@marmeon/session' {
  interface SessionData {
    _auth_id: string | number;
    _auth_password: string;
    _auth_confirmed_at: number;
    _auth_via_remember: boolean;
    _auth_pending: PendingSecondFactor;
    _auth_two_factor_at: number;
  }
}

declare module '@marmeon/cache' {
  interface LimiterContext {
    /** The signed-in user, when `authenticate()` runs before `throttle()` on the route — else `undefined`. */
    readonly user?: AuthUser | undefined;
  }
}

/**
 * What the session remembers of the account: a SHA-256 of its id, its password hash and its session key. A new
 * password or a new session key (`auth.updateSessionKey()`) changes it, so every other session's fingerprint stops matching —
 * and that session ends. Two accounts never share one, also without a password. The hash itself never goes into the session.
 */
export function sessionFingerprint(credentials: Credentials): string {
  const parts = [String(idOf(credentials.user)), credentials.passwordHash ?? '', credentials.sessionKey ?? ''];
  return oneShotHash('sha256', `marmeon-auth:${JSON.stringify(parts)}`, 'base64url');
}

export interface LoginOptions {
  /** Keep the user signed in on this device beyond the session ("remember me"). */
  readonly remember?: boolean;
  /**
   * The client's address for the `Login` event (for "a new sign-in" notices, audit logs). Default: the request's (`RequestInfo`,
   * through `TRUSTED_PROXIES` like `ctx.ip`) — pass it only to say something else.
   */
  readonly ip?: string | undefined;
  /** The browser's `User-Agent` header for the `Login` event — default: the request's, like `ip`. */
  readonly userAgent?: string | undefined;
}

/**
 * Who is signed in — for this request (scoped, injected like the `Session`). The session guard of
 * the `web` group: sign in with `attempt`/`login`, out with `logout`, ask with `user`/`check`/`id`.
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
  readonly #remember: RememberTokenStore;
  readonly #config: AuthConfig;
  readonly #sessionConfig: SessionConfig;
  readonly #logger: Logger;
  readonly #history: ClientHistory;
  readonly #request: RequestInfo;
  readonly #newPassword: NewPassword;
  readonly #twoFactor: TwoFactorState;
  #user: Promise<AuthUser | undefined> | undefined;

  constructor(
    session: Session,
    users: UserProvider,
    hasher: Hasher,
    events: EventDispatcher,
    cookies: CookieJar,
    remember: RememberTokenStore,
    config: AuthConfig,
    sessionConfig: SessionConfig,
    logger: Logger,
    history: ClientHistory,
    request: RequestInfo,
    newPassword: NewPassword,
    twoFactor: TwoFactorState,
  ) {
    this.#session = session;
    this.#users = users;
    this.#hasher = hasher;
    this.#events = events;
    this.#cookies = cookies;
    this.#remember = remember;
    this.#config = config;
    this.#sessionConfig = sessionConfig;
    this.#logger = logger;
    this.#history = history;
    this.#request = request;
    this.#newPassword = newPassword;
    this.#twoFactor = twoFactor;
  }

  /**
   * Checks the credentials and signs the user in: `ok` with the user, or an `err` — `invalid-credentials`, or `two-factor-required`
   * when the password was right but the account has a second factor (see {@link TwoFactorState}). Then nobody is signed in: the
   * session waits for the factor (`pendingSecondFactor()`), and an app that does not handle that case shows a failed sign-in at worst.
   * See `docs/errors.md#results`. There is one kind for an unknown identifier, a wrong password and an
   * account without a password alike — in the same time (`dummyVerify`), so neither the answer nor its duration
   * tells which addresses have an account. Rehashes the password when the costs changed.
   */
  async attempt(identifier: string, password: string, options: LoginOptions = {}): Promise<Result<AuthUser, AttemptError>> {
    const credentials = await this.#check(identifier, password);
    if (!credentials) return err({ kind: 'invalid-credentials' });
    // The fingerprint from the account as findById() sees it — what every later request compares with (the session key included).
    const current = await this.#credentials(credentials.user);
    // The one fork for every password sign-in: an account with a factor is never signed in here, whatever the caller does with the err.
    const factors = await this.#twoFactor.factors(idOf(credentials.user));
    if (factors.length > 0) {
      this.#hold(current, factors, options, 'attempt');
      return err({ kind: 'two-factor-required', factors });
    }
    await this.#login(current, options, 'attempt');
    this.#session.put(AUTH_SESSION_KEYS.confirmedAt, now()); // the password was just typed
    return ok(credentials.user);
  }

  /**
   * Signs `user` in (after registration, say): new session id and CSRF token, fingerprint of the current hash. `'signed-in'`, or
   * `'two-factor-required'` for an account with a second factor — then nobody is signed in, exactly as with `attempt()`.
   */
  async login(user: AuthUser, options: LoginOptions = {}): Promise<'signed-in' | 'two-factor-required'> {
    const credentials = await this.#credentials(user);
    const factors = await this.#twoFactor.factors(idOf(user));
    if (factors.length > 0) {
      this.#hold(credentials, factors, options, 'login');
      return 'two-factor-required';
    }
    await this.#login(credentials, options, 'login');
    return 'signed-in';
  }

  /** The factors a sign-in waits for, or `undefined` when none waits (or it ran out). The waiting account is not signed in: `user()` is `undefined`. */
  pendingSecondFactor(): { readonly factors: readonly SecondFactor[] } | undefined {
    const pending = this.#pending();
    return pending === undefined ? undefined : { factors: pending.factors };
  }

  [READ_PENDING](): PendingView | undefined {
    const pending = this.#pending();
    return pending === undefined ? undefined : { userId: pending.id, factors: pending.factors, failures: pending.failures, remember: pending.remember };
  }

  /**
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
    if (!found || !equal(pending.fingerprint, sessionFingerprint(found))) return err({ kind: 'expired' });
    await this.#login(found, { remember: pending.remember }, pending.via);
    this.#session.put(AUTH_SESSION_KEYS.confirmedAt, now());
    this.#session.put(AUTH_SESSION_KEYS.twoFactorAt, now());
    return ok(found.user);
  }

  /**
   * Signs out on this device: the session's data, id and CSRF token are all replaced, the remember-me token is dropped.
   * The browser loads the next page fully (its in-memory pages are gone) and clears the site's storage
   * (`Clear-Site-Data: "storage"`; signed-in answers are `no-store`, so the HTTP cache holds none of them) — see `ClientHistory`; an app that keeps something in
   * the browser's storage across a sign-out takes that back with `history.clear({ siteData: false })` after `logout()`.
   */
  async logout(): Promise<void> {
    const user = await this.user();
    await this.#forgetDevice();
    this.#session.invalidate();
    this.#history.clear({ siteData: ['storage'] });
    this.#user = Promise.resolve(undefined);
    if (user) await this.#events.dispatch(new Logout(user));
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
    return this.#session.started && this.#session.get(AUTH_SESSION_KEYS.viaRemember) === true;
  }

  /**
   * Checks the signed-in user's password again (before sensitive actions) and, if right, notes the
   * time for `confirmedPassword()`. Takes as long when there is no user or no password.
   */
  async confirmPassword(password: string): Promise<boolean> {
    const credentials = await this.#current();
    const ok = credentials?.passwordHash ? await this.#hasher.verify(password, credentials.passwordHash) : await this.#hasher.dummyVerify(password);
    if (ok) this.#session.put(AUTH_SESSION_KEYS.confirmedAt, now());
    return ok;
  }

  /** Whether the password was typed within `seconds` (default `AUTH_PASSWORD_TIMEOUT`). */
  passwordRecentlyConfirmed(seconds = this.#config.passwordTimeout): boolean {
    const at = this.#session.started ? this.#session.get(AUTH_SESSION_KEYS.confirmedAt) : undefined;
    return typeof at === 'number' && now() - at < seconds;
  }

  /**
   * Sets a new password for the signed-in user. Every other session ends (their fingerprint no
   * longer matches) and every remember-me token is dropped — this device's too; this session stays.
   * With `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`, every API token of the user is revoked in the transaction of the new hash.
   */
  async updatePassword(password: string): Promise<void> {
    const user = await this.#requireUser('updatePassword');
    const hash = await this.#hasher.make(password);
    const revoked = await this.#newPassword.store(this.#users, this.#remember, idOf(user), hash, 'change');
    this.#cookies.delete(this.#config.rememberCookie);
    this.#session.put(AUTH_SESSION_KEYS.password, sessionFingerprint(await this.#credentials(user)));
    this.#session.put(AUTH_SESSION_KEYS.confirmedAt, now());
    await this.#events.dispatch(new PasswordChanged(user, revoked));
  }

  /**
   * Signs out every other device: checks `password`, then hashes it
   * anew — a new salt, a new hash, so the other sessions' fingerprints stop matching — and drops the
   * other devices' remember-me tokens. `false` for a wrong password.
   */
  async logoutOtherDevices(password: string): Promise<boolean> {
    const user = await this.#requireUser('logoutOtherDevices');
    if (!(await this.confirmPassword(password))) return false;
    const hash = await this.#hasher.make(password);
    await this.#users.updatePasswordHash(idOf(user) as never, hash);
    await this.#remember.forgetUser(idOf(user), this.#cookies.get(this.#config.rememberCookie));
    this.#session.put(AUTH_SESSION_KEYS.password, sessionFingerprint(await this.#credentials(user)));
    return true;
  }

  /**
   * Signs out every other device without a password — for accounts that sign in by link or OAuth, or whenever the app
   * confirmed the user its own way before: stores a new random session key (`UserProvider.updateSessionKey()`), so the other
   * sessions' fingerprints stop matching, and drops the other devices' remember-me tokens; this session stays. Throws when the
   * provider cannot store a key, or does not hand it back from `findById()` — it never pretends to have signed anybody out.
   */
  async updateSessionKey(): Promise<void> {
    const user = await this.#requireUser('updateSessionKey');
    if (typeof this.#users.updateSessionKey !== 'function') {
      throw new Error(
        'auth.updateSessionKey() needs UserProvider.updateSessionKey(id, key): store the key in a column of the account ' +
          '(a session_key column) and hand it back as sessionKey from findById() and findForLogin().',
      );
    }
    const key = randomBytes(32).toString('base64url');
    await this.#users.updateSessionKey(idOf(user) as never, key);
    const credentials = await this.#credentials(user);
    if (credentials.sessionKey !== key) {
      throw new Error(
        'auth.updateSessionKey() stored a new key, but UserProvider.findById() does not hand it back as sessionKey — the other ' +
          'sessions would stay signed in. Return the session_key column as sessionKey from findById() and findForLogin().',
      );
    }
    await this.#remember.forgetUser(idOf(user), this.#cookies.get(this.#config.rememberCookie));
    this.#session.put(AUTH_SESSION_KEYS.password, sessionFingerprint(credentials));
  }

  async #check(identifier: string, password: string): Promise<Credentials | undefined> {
    const found = await this.#users.findForLogin(identifier);
    if (!found || found.passwordHash === null) {
      await this.#hasher.dummyVerify(password);
      await this.#events.dispatch(new Failed(identifier, found?.user));
      return undefined;
    }
    if (!(await this.#hasher.verify(password, found.passwordHash))) {
      await this.#events.dispatch(new Failed(identifier, found.user));
      return undefined;
    }
    if (!this.#hasher.needsRehash(found.passwordHash)) return found;
    const passwordHash = await this.#hasher.make(password);
    await this.#users.updatePasswordHash(idOf(found.user) as never, passwordHash);
    return { ...found, passwordHash };
  }

  async #login(credentials: Credentials, { remember = false, ip = this.#request.ip, userAgent = this.#request.userAgent }: LoginOptions, via: LoginVia): Promise<void> {
    const { user } = credentials;
    const viaRemember = via === 'remember';
    // A session id (and CSRF token) handed out before login must not survive it: session fixation.
    this.#session.regenerate();
    this.#session.forget(AUTH_SESSION_KEYS.pending);
    this.#session.forget(AUTH_SESSION_KEYS.twoFactorAt);
    this.#session.put(AUTH_SESSION_KEYS.id, idOf(user));
    this.#session.put(AUTH_SESSION_KEYS.password, sessionFingerprint(credentials));
    if (viaRemember) this.#session.put(AUTH_SESSION_KEYS.viaRemember, true);
    else this.#session.forget(AUTH_SESSION_KEYS.viaRemember);
    if (remember && !viaRemember) {
      const expiresAt = new Date(Date.now() + this.#config.rememberDays * 86_400_000);
      await this.#forgetDevice(); // one token per device
      this.#setCookie(await this.#remember.create(idOf(user), expiresAt), expiresAt);
    }
    this.#user = Promise.resolve(user);
    // Another person may sit at this browser now: pages kept from before the sign-in must not come back.
    // (A remember-me sign-in continues the same person's session — no reload for that.)
    if (!viaRemember) this.#history.clear();
    await this.#events.dispatch(new Login(user, remember || viaRemember, new Date(), { via, ip, userAgent }));
  }

  /**
   * Parks a correct password: a new session id (as at sign-in), every sign-in key gone, only {@link PendingSecondFactor} left.
   * Invariant: no `Login` event, no remember-me token or cookie, no `_auth_id` — the account is not signed in until a factor is proven.
   */
  #hold(credentials: Credentials, factors: readonly SecondFactor[], { remember = false }: LoginOptions, via: LoginVia): void {
    this.#session.regenerate();
    for (const key of [AUTH_SESSION_KEYS.id, AUTH_SESSION_KEYS.password, AUTH_SESSION_KEYS.confirmedAt, AUTH_SESSION_KEYS.viaRemember, AUTH_SESSION_KEYS.twoFactorAt] as const) {
      this.#session.forget(key);
    }
    this.#session.put(AUTH_SESSION_KEYS.pending, {
      id: idOf(credentials.user),
      fingerprint: sessionFingerprint(credentials),
      remember,
      via,
      until: now() + PENDING_SECONDS,
      failures: 0,
      factors,
    });
    this.#user = Promise.resolve(undefined);
    // Pages of the person before may still be in the browser; the next person is at the keyboard (as at sign-in).
    this.#history.clear();
  }

  /** The pending sign-in if it is well-formed and has not run out; anything else counts as none. */
  #pending(): PendingSecondFactor | undefined {
    if (!this.#session.started) return undefined;
    const pending = this.#session.get(AUTH_SESSION_KEYS.pending);
    if (typeof pending !== 'object' || pending === null || typeof pending.until !== 'number' || pending.until <= now()) return undefined;
    if (!Array.isArray(pending.factors) || typeof pending.fingerprint !== 'string') return undefined;
    return pending;
  }

  async #resolve(): Promise<AuthUser | undefined> {
    if (!this.#session.started) return undefined; // the stateless `api` group has no session
    const id = this.#session.get(AUTH_SESSION_KEYS.id);
    if (id === undefined) return this.#fromRememberCookie();
    const found = await this.#users.findById(id as never);
    const fingerprint = this.#session.get(AUTH_SESSION_KEYS.password);
    if (!found || typeof fingerprint !== 'string' || !equal(fingerprint, sessionFingerprint(found))) {
      // Deleted, or the password or the session key changed since this session signed in: this session ends — by the next request that may
      // write it (an island's is read-only: for it, nobody is signed in).
      if (!this.#session.readOnly) this.#session.invalidate();
      return undefined;
    }
    return found.user;
  }

  async #fromRememberCookie(): Promise<AuthUser | undefined> {
    const cookie = this.#cookies.get(this.#config.rememberCookie);
    // A read-only request (an island) cannot sign in: consuming the token rotates it, and the new one would never
    // reach the browser (the next request would present the old one — "stolen"). The page's request signs in.
    if (!cookie || this.#session.readOnly) return undefined;
    const result = await this.#remember.consume(cookie);
    if (!result.ok) {
      this.#cookies.delete(this.#config.rememberCookie);
      if (result.error.kind === 'stolen') {
        this.#logger.warn('A rotated remember-me token was used again: all remember-me tokens of the user were revoked', { user: result.error.userId });
      }
      return undefined;
    }
    const device = result.value;
    const found = await this.#users.findById(device.userId as never);
    if (!found) {
      await this.#remember.forget(device.cookie ?? cookie);
      this.#cookies.delete(this.#config.rememberCookie);
      return undefined;
    }
    if (device.cookie) this.#setCookie(device.cookie, device.expiresAt);
    await this.#login(found, {}, 'remember');
    // Every token of an account with a factor was made on a device that proved it (tokens made before the factor existed are dropped
    // when it is turned on), so this device has proven it too.
    if ((await this.#twoFactor.factors(device.userId)).length > 0) this.#session.put(AUTH_SESSION_KEYS.twoFactorAt, now());
    return found.user;
  }

  async #forgetDevice(): Promise<void> {
    const cookie = this.#cookies.get(this.#config.rememberCookie);
    if (cookie) await this.#remember.forget(cookie);
    if (cookie !== undefined) this.#cookies.delete(this.#config.rememberCookie);
  }

  #setCookie(value: string, expiresAt: Date): void {
    const { secure, sameSite } = this.#sessionConfig;
    const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    this.#cookies.set(this.#config.rememberCookie, value, { httpOnly: true, secure, sameSite, maxAge });
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

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

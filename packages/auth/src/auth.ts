import { createHash, timingSafeEqual } from 'node:crypto';
import { EventDispatcher, Logger } from '@bespokecore/core';
import { ClientHistory } from '@bespokecore/http';
import { CookieJar } from '@bespokecore/router';
import { Session, SESSION_USER_KEY, SessionConfig } from '@bespokecore/session';
import { AuthConfig } from './config.ts';
import { Failed, Login, Logout, PasswordChanged } from './events.ts';
import { Hasher, type PasswordHash } from './hashing.ts';
import { RememberTokenStore } from './remember.ts';
import { idOf, UserProvider, type AuthUser, type AuthUserId, type Credentials } from './user.ts';

/** Session keys of the signed-in user — `_`-prefixed: framework bookkeeping, left out of `session.all()`. */
export const AUTH_SESSION_KEYS = {
  /** The user's id (the session package's key: the `database` session driver copies it into `user_id`). */
  id: SESSION_USER_KEY,
  /** A fingerprint of the user's password hash when the session signed in (E26). */
  password: '_auth_password',
  /** When the password was last typed (sign-in, confirmation), in Unix seconds — for `confirmedPassword()`. */
  confirmedAt: '_auth_confirmed_at',
  /** Signed in by the remember-me cookie, not by a password. */
  viaRemember: '_auth_via_remember',
} as const;

declare module '@bespokecore/session' {
  interface SessionData {
    _auth_id: string | number;
    _auth_password: string;
    _auth_confirmed_at: number;
    _auth_via_remember: boolean;
  }
}

/**
 * What the session remembers of the password hash: a SHA-256 of it. A password change anywhere
 * changes the hash, so every other session's fingerprint stops matching — and that session ends.
 * The hash itself never goes into the session.
 */
export function passwordFingerprint(hash: PasswordHash | null): string {
  return createHash('sha256').update(`bespoke-auth:${hash ?? ''}`).digest('base64url');
}

export interface LoginOptions {
  /** Keep the user signed in on this device beyond the session ("remember me"). */
  readonly remember?: boolean;
}

/**
 * Who is signed in — for this request (scoped, injected like the `Session`). The session guard of
 * the `web` group: sign in with `attempt`/`login`, out with `logout`, ask with `user`/`check`/`id`.
 *
 * ```ts
 * const user = await this.#auth.attempt(ctx.body.email, ctx.body.password, { remember: ctx.body.remember });
 * if (!user) throw new ValidationError({ email: ['These credentials do not match our records.'] });
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
  }

  /**
   * Checks the credentials and signs the user in. `undefined` for an unknown identifier and for a
   * wrong password alike — in the same time (`dummyVerify`), so neither the answer nor its duration
   * tells which addresses have an account. Rehashes the password when the costs changed.
   */
  async attempt(identifier: string, password: string, options: LoginOptions = {}): Promise<AuthUser | undefined> {
    const credentials = await this.#check(identifier, password);
    if (!credentials) return undefined;
    await this.#login(credentials.user, credentials.passwordHash, options);
    this.#session.put(AUTH_SESSION_KEYS.confirmedAt, now()); // the password was just typed
    return credentials.user;
  }

  /** Signs `user` in (after registration, say): new session id and CSRF token, fingerprint of the current hash. */
  async login(user: AuthUser, options: LoginOptions = {}): Promise<void> {
    const credentials = await this.#credentials(user);
    await this.#login(credentials.user, credentials.passwordHash, options);
  }

  /**
   * Signs out on this device: the session's data, id and CSRF token are all replaced, the remember-me token is dropped.
   * The browser loads the next page fully (its in-memory pages are gone) and clears its HTTP cache for the site
   * (`Clear-Site-Data: "cache"`) — see `ClientHistory`.
   */
  async logout(): Promise<void> {
    const user = await this.user();
    await this.#forgetDevice();
    this.#session.invalidate();
    this.#history.clear({ siteCache: true });
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
   */
  async updatePassword(password: string): Promise<void> {
    const user = await this.#requireUser('updatePassword');
    const hash = await this.#hasher.make(password);
    await this.#users.updatePasswordHash(idOf(user) as never, hash);
    await this.#remember.forgetUser(idOf(user));
    this.#cookies.delete(this.#config.rememberCookie);
    this.#session.put(AUTH_SESSION_KEYS.password, passwordFingerprint(hash));
    this.#session.put(AUTH_SESSION_KEYS.confirmedAt, now());
    await this.#events.dispatch(new PasswordChanged(user));
  }

  /**
   * Signs out every other device (Laravel's `logoutOtherDevices`): checks `password`, then hashes it
   * anew — a new salt, a new hash, so the other sessions' fingerprints stop matching — and drops the
   * other devices' remember-me tokens. `false` for a wrong password.
   */
  async logoutOtherDevices(password: string): Promise<boolean> {
    const user = await this.#requireUser('logoutOtherDevices');
    if (!(await this.confirmPassword(password))) return false;
    const hash = await this.#hasher.make(password);
    await this.#users.updatePasswordHash(idOf(user) as never, hash);
    await this.#remember.forgetUser(idOf(user), this.#cookies.get(this.#config.rememberCookie));
    this.#session.put(AUTH_SESSION_KEYS.password, passwordFingerprint(hash));
    return true;
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
    return { user: found.user, passwordHash };
  }

  async #login(user: AuthUser, hash: PasswordHash | null, { remember = false }: LoginOptions, viaRemember = false): Promise<void> {
    // A session id (and CSRF token) handed out before login must not survive it: session fixation.
    this.#session.regenerate();
    this.#session.put(AUTH_SESSION_KEYS.id, idOf(user));
    this.#session.put(AUTH_SESSION_KEYS.password, passwordFingerprint(hash));
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
    await this.#events.dispatch(new Login(user, remember || viaRemember));
  }

  async #resolve(): Promise<AuthUser | undefined> {
    if (!this.#session.started) return undefined; // the stateless `api` group has no session
    const id = this.#session.get(AUTH_SESSION_KEYS.id);
    if (id === undefined) return this.#fromRememberCookie();
    const found = await this.#users.findById(id as never);
    const fingerprint = this.#session.get(AUTH_SESSION_KEYS.password);
    if (!found || typeof fingerprint !== 'string' || !equal(fingerprint, passwordFingerprint(found.passwordHash))) {
      // Deleted, or the password changed since this session signed in: this session ends — by the next request that may
      // write it (an island's is read-only, E52: for it, nobody is signed in).
      if (!this.#session.readOnly) this.#session.invalidate();
      return undefined;
    }
    return found.user;
  }

  async #fromRememberCookie(): Promise<AuthUser | undefined> {
    const cookie = this.#cookies.get(this.#config.rememberCookie);
    // A read-only request (an island, E52) cannot sign in: consuming the token rotates it, and the new one would never
    // reach the browser (the next request would present the old one — "stolen"). The page's request signs in.
    if (!cookie || this.#session.readOnly) return undefined;
    const result = await this.#remember.consume(cookie);
    if (result?.kind !== 'valid') {
      this.#cookies.delete(this.#config.rememberCookie);
      if (result?.kind === 'stolen') {
        this.#logger.warn('A rotated remember-me token was used again: all remember-me tokens of the user were revoked', { user: result.userId });
      }
      return undefined;
    }
    const found = await this.#users.findById(result.userId as never);
    if (!found) {
      await this.#remember.forget(result.cookie ?? cookie);
      this.#cookies.delete(this.#config.rememberCookie);
      return undefined;
    }
    if (result.cookie) this.#setCookie(result.cookie, result.expiresAt);
    await this.#login(found.user, found.passwordHash, {}, true);
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

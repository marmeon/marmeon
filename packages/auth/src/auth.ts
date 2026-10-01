import { createHash, timingSafeEqual } from 'node:crypto';
import { EventDispatcher } from '@bespokecore/core';
import { Session } from '@bespokecore/session';
import { Failed, Login, Logout } from './events.ts';
import { Hasher, type PasswordHash } from './hashing.ts';
import { idOf, UserProvider, type AuthUser, type AuthUserId, type Credentials } from './user.ts';

/** Session keys of the signed-in user — `_`-prefixed: framework bookkeeping, left out of `session.all()`. */
export const AUTH_SESSION_KEYS = {
  /** The user's id. */
  id: '_auth_id',
  /** A fingerprint of the user's password hash when the session signed in (E26). */
  password: '_auth_password',
} as const;

declare module '@bespokecore/session' {
  interface SessionData {
    _auth_id: string | number;
    _auth_password: string;
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

/**
 * Who is signed in — for this request (scoped, injected like the `Session`). The session guard of
 * the `web` group: sign in with `attempt`/`login`, out with `logout`, ask with `user`/`check`/`id`.
 *
 * ```ts
 * const user = await this.#auth.attempt(ctx.body.email, ctx.body.password);
 * if (!user) throw new ValidationError({ email: ['These credentials do not match our records.'] });
 * ```
 */
export class Auth {
  readonly #session: Session;
  readonly #users: UserProvider;
  readonly #hasher: Hasher;
  readonly #events: EventDispatcher;
  #user: Promise<AuthUser | undefined> | undefined;

  constructor(session: Session, users: UserProvider, hasher: Hasher, events: EventDispatcher) {
    this.#session = session;
    this.#users = users;
    this.#hasher = hasher;
    this.#events = events;
  }

  /**
   * Checks the credentials and signs the user in. `undefined` for an unknown identifier and for a
   * wrong password alike — in the same time (`dummyVerify`), so neither the answer nor its duration
   * tells which addresses have an account. Rehashes the password when the costs changed.
   */
  async attempt(identifier: string, password: string): Promise<AuthUser | undefined> {
    const credentials = await this.#check(identifier, password);
    if (!credentials) return undefined;
    await this.#login(credentials.user, credentials.passwordHash);
    return credentials.user;
  }

  /** Signs `user` in (after registration, say): new session id and CSRF token, fingerprint of the current hash. */
  async login(user: AuthUser): Promise<void> {
    const credentials = await this.#users.findById(idOf(user) as never);
    if (!credentials) throw new Error(`Cannot sign in user ${idOf(user)}: the UserProvider does not find them.`);
    await this.#login(credentials.user, credentials.passwordHash);
  }

  /** Signs out: the session's data, id and CSRF token are all replaced. */
  async logout(): Promise<void> {
    const user = await this.user();
    this.#session.invalidate();
    this.#user = Promise.resolve(undefined);
    if (user) await this.#events.dispatch(new Logout(user));
  }

  /** The signed-in user — looked up once per request. */
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

  async #login(user: AuthUser, hash: PasswordHash | null): Promise<void> {
    // A session id (and CSRF token) handed out before login must not survive it: session fixation.
    this.#session.regenerate();
    this.#session.put(AUTH_SESSION_KEYS.id, idOf(user));
    this.#session.put(AUTH_SESSION_KEYS.password, passwordFingerprint(hash));
    this.#user = Promise.resolve(user);
    await this.#events.dispatch(new Login(user));
  }

  async #resolve(): Promise<AuthUser | undefined> {
    if (!this.#session.started) return undefined; // the stateless `api` group has no session
    const id = this.#session.get(AUTH_SESSION_KEYS.id);
    if (id === undefined) return undefined;
    const found = await this.#users.findById(id as never);
    const fingerprint = this.#session.get(AUTH_SESSION_KEYS.password);
    if (!found || typeof fingerprint !== 'string' || !equal(fingerprint, passwordFingerprint(found.passwordHash))) {
      // Deleted, or the password changed since this session signed in: this session ends.
      this.#session.invalidate();
      return undefined;
    }
    return found.user;
  }
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

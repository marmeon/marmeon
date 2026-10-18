import { token, type Token } from '@marmeon/core';
import type { PasswordHash } from './hashing.ts';

/**
 * The app's user type, declared once — like `SessionData` or `SharedProps`:
 *
 * ```ts
 * declare module '@marmeon/auth' {
 *   interface AuthTypes { user: User }
 * }
 * ```
 *
 * `ctx.user`, `auth.user()`, `actingAs(…)` and the `UserProvider` are typed by it.
 */
export interface AuthTypes {}

declare const missing: unique symbol;

/** What `ctx.user` is until `AuthTypes` names the user type — every use of it says what to do. */
export interface AuthTypesNotDeclared {
  readonly [missing]: 'Declare the user type: declare module "@marmeon/auth" { interface AuthTypes { user: User } }';
}

/** The user type of `Types` — or {@link AuthTypesNotDeclared}. Users need an `id`. */
export type UserOf<Types> = Types extends { user: infer U extends { readonly id: string | number } } ? U : AuthTypesNotDeclared;

/** The app's user (from {@link AuthTypes}). */
export type AuthUser = UserOf<AuthTypes>;

/** The type of a user's id. */
export type AuthUserId = AuthUser extends { readonly id: infer Id } ? Id : string | number;

/** A user together with their password hash — which never becomes part of the user. */
export interface Credentials<U = AuthUser> {
  readonly user: U;
  /** `null` for users who cannot sign in with a password (e.g. only by link or OAuth). */
  readonly passwordHash: PasswordHash | null;
  /**
   * A value of the account that `auth.updateSessionKey()` replaces to end the account's other sessions — a `session_key`
   * column the app keeps. `null` while the account has none (seeded or imported accounts).
   */
  readonly sessionKey: string | null;
}

/**
 * Where users come from — the app's repository implements it and binds it in a provider:
 * `container.bind(UserProvider, UserRepository)`. The hash travels next to the user, never inside it.
 */
export interface UserProvider<U = AuthUser> {
  /** The user and their current hash (the session checks it on every request). Returns `sessionKey` (`null` when the account has none) — `findForLogin()` must too, or `attempt()` throws. It must read after write (no cache, no lagging replica): every session and remember-me check compares what it returns with what was just written. */
  findById(id: U extends { readonly id: infer Id } ? Id : never): Promise<Credentials<U> | undefined>;
  /** By what people type to sign in — usually the e-mail, already normalized by the request schema. Returns `sessionKey` (`null` when the account has none), as `findById()` does, or `attempt()` throws. */
  findForLogin(identifier: string): Promise<Credentials<U> | undefined>;
  /**
   * Stores a new hash (rehash on login, password change, reset) and returns whether it wrote. With `expected` it is a compare-and-set:
   * write `hash` only when the stored hash equals `expected`, in **one** statement (`UPDATE … WHERE password = expected`) — a rehash
   * over the hash it verified, or `logoutOtherDevices()`, must never put an old password back over a reset that landed meanwhile.
   * Without `expected` it writes regardless (a reset, a new password) and returns `true` once it wrote. With `sessionKey` the **same**
   * statement stores that session key as well (see `updateSessionKey()`), so the hash and the key never stand apart.
   * An answer that is not a boolean is refused: a provider that does not say whether it wrote could put an old hash back unnoticed.
   */
  updatePasswordHash(
    id: U extends { readonly id: infer Id } ? Id : never,
    hash: PasswordHash,
    options?: { readonly expected?: PasswordHash; readonly sessionKey?: string },
  ): Promise<boolean>;
  /**
   * Stores a new session key (`auth.updateSessionKey()`, `AccountSessions`); `findById()` and `findForLogin()` hand it back as
   * `sessionKey`. Compare-and-set: write `key` only when the stored key equals `expected` (`null`: none), in **one** statement
   * (`UPDATE … WHERE session_key = expected`), and return whether it wrote. Two callers that read the same key must not both win.
   * `expected === undefined` writes regardless of the stored key: `AccountSessions.end()` passes it, to end every session of an
   * account, and must not fail because somebody else replaced the key at the same time.
   * `updateSessionKey(id, k, k)` with `k` the stored key must return `true`: a new factor takes the account's row lock that way, and
   * a provider that skips no-op writes or counts only changed rows would sign the user out of every factor setup.
   */
  updateSessionKey(id: U extends { readonly id: infer Id } ? Id : never, key: string, expected: string | null | undefined): Promise<boolean>;
  /**
   * Writes `key` into the session key of **every** account in **one** statement (`UPDATE users SET session_key = ?`), whatever the
   * stored keys are, and returns how many rows it wrote. `AccountSessions.endEveryone()` calls it with one fresh key for all
   * accounts: the fingerprint includes the account's id, so two accounts never share one. `findById()` must hand the new key back
   * at once (read-after-write; no cache). Answer with how many rows you wrote and the id of one account you wrote (`sampleId`,
   * required when `accounts > 0`; an empty table has none to give): `AccountSessions` reads it back and throws unless its `sessionKey` is `key`, since otherwise
   * every session would stay live. The UPDATE must have no `WHERE` clause (no tenant or soft-delete scope) — a sample cannot
   * detect a scoped one.
   */
  updateEverySessionKey(key: string): Promise<{ readonly accounts: number; readonly sampleId: (U extends { readonly id: infer Id } ? Id : never) | undefined }>;
}
// Annotated: the declaration then names `UserProvider` instead of spelling out the app's user type.
export const UserProvider: Token<UserProvider> = token<UserProvider>('UserProvider');

/** What `authenticate()` adds to the context. */
export interface Authenticated {
  readonly user: AuthUser;
}

/** The id of a user — typed loosely inside the package, which does not know the app's user type. */
export function idOf(user: unknown): string | number {
  const id = (user as { id?: unknown }).id;
  if (typeof id !== 'string' && typeof id !== 'number') throw new TypeError('A user needs an `id` (string or number) to be signed in.');
  return id;
}

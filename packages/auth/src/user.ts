import { token, type Token } from '@bespokecore/core';
import type { PasswordHash } from './hashing.ts';

/**
 * The app's user type, declared once (E24) — like `SessionData` or `SharedProps`:
 *
 * ```ts
 * declare module '@bespokecore/auth' {
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
  readonly [missing]: 'Declare the user type: declare module "@bespokecore/auth" { interface AuthTypes { user: User } }';
}

/** The user type of `Types` — or {@link AuthTypesNotDeclared}. Users need an `id`. */
export type UserOf<Types> = Types extends { user: infer U extends { readonly id: string | number } } ? U : AuthTypesNotDeclared;

/** The app's user (from {@link AuthTypes}). */
export type AuthUser = UserOf<AuthTypes>;

/** The type of a user's id. */
export type AuthUserId = AuthUser extends { readonly id: infer Id } ? Id : string | number;

/** A user together with their password hash — which never becomes part of the user (E24). */
export interface Credentials<U = AuthUser> {
  readonly user: U;
  /** `null` for users who cannot sign in with a password (e.g. only by link or OAuth, later). */
  readonly passwordHash: PasswordHash | null;
}

/**
 * Where users come from — the app's repository implements it and binds it in a provider:
 * `container.bind(UserProvider, UserRepository)`. The hash travels next to the user, never inside it.
 */
export interface UserProvider<U = AuthUser> {
  /** The user and their current hash (the session checks it on every request). */
  findById(id: U extends { readonly id: infer Id } ? Id : never): Promise<Credentials<U> | undefined>;
  /** By what people type to sign in — usually the e-mail, already normalized by the request schema. */
  findForLogin(identifier: string): Promise<Credentials<U> | undefined>;
  /** Stores a new hash (rehash on login, password change, reset). */
  updatePasswordHash(id: U extends { readonly id: infer Id } ? Id : never, hash: PasswordHash): Promise<void>;
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

import { hash } from 'node:crypto';
import { token } from '@marmeon/core';

export type SessionPayload = Record<string, unknown>;

/** A session as its store keeps it: the payload as text (JSON, or encrypted with `SESSION_ENCRYPT`) and its version. */
export interface StoredSession {
  readonly data: string;
  /** Goes up by one with every write — what `write` compares (compare-and-set). */
  readonly version: number;
}

/** How a session is written: as a new one, or back over the version it was read at. */
export interface SessionWrite {
  /**
   * The version `read` returned — written only while the session is still at it. `undefined`: a new key (a new session, or one
   * regenerated at sign-in/sign-out): written only when nothing is stored under it.
   */
  readonly expectedVersion: number | undefined;
  /** How long the session lives after this write. */
  readonly lifetimeSeconds: number;
  /** The signed-in user's id, or null for a guest — the `database` store keeps it in `user_id` (the payload may be encrypted). */
  readonly userId?: string | null;
}

/**
 * What a write did:
 * - `written` — stored (version + 1, or 1 for a new key);
 * - `conflict` — another request wrote the session since it was read (or, for a new key, something is stored under it): nothing
 *   was written, read it again;
 * - `gone` — the session no longer exists (destroyed by a sign-out or sign-in of the same browser, or expired): nothing was
 *   written, and nothing ever brings it back.
 */
export type SessionWriteResult = 'written' | 'conflict' | 'gone';

/**
 * Where session data lives: `file`, `database`, `redis`, `memory` and `cookie` implement this
 * contract (`stores/`).
 *
 * Every method takes the session's **key** — `sessionKey(id)`, the SHA-256 of the id the cookie carries — never the id:
 * whoever reads the store (a leaked backup, a replica, a shared Redis) gets no cookie that works. The payload is text the
 * store keeps as it is.
 *
 * `write` is ONE atomic step of the store — compare-and-set on the version: there is no moment between "it is at
 * version n" and "store version n + 1" in which another request's write or `destroy` could slip.
 */
export interface SessionStore {
  read(key: string): Promise<StoredSession | undefined>;
  write(key: string, data: string, options: SessionWrite): Promise<SessionWriteResult>;
  destroy(key: string): Promise<void>;
  /** Removes expired sessions; returns how many (0 for stores that expire on their own: Redis, cookies). */
  gc(lifetimeSeconds: number): Promise<number>;
  /**
   * Removes every session of the user `userId` (its id as text) — how many. Only a store that knows whose a session is has it
   * (`database`: the `user_id` column). Without it a deleted user's sessions end at their next request anyway — the guard of
   * `@marmeon/auth` finds no user and invalidates them — and expire with their lifetime.
   */
  destroyUser?(userId: string): Promise<number>;
}
export const SessionStore = token<SessionStore>('SessionStore');

/** Session ids are 40 URL-safe characters — anything else is never looked up (no path tricks). */
export const SESSION_ID = /^[A-Za-z0-9_-]{40}$/;

/** A store key: 64 lowercase hex characters (SHA-256). */
export const SESSION_KEY = /^[0-9a-f]{64}$/;

/**
 * The session key holding the signed-in user's id (`@marmeon/auth` writes it). The `database` store keeps it in the
 * `user_id` column, so an app can list or end a user's sessions.
 */
export const SESSION_USER_KEY = '_auth_id';

export function createSessionId(): string {
  return crypto.getRandomValues(new Uint8Array(30)).toBase64({ alphabet: 'base64url' });
}

/**
 * The key a session is stored under: the SHA-256 of its id, hex. The id itself (240 random
 * bits) stays in the cookie; a store that leaks yields keys nobody can sign in with, and nothing can be worked back from them.
 */
export function sessionKey(id: string): string {
  return hash('sha256', id, 'hex'); // the one-shot hash: ≈ 0.26 µs, createHash ≈ 0.45 (once per request with a cookie)
}

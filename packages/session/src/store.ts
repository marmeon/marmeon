import { token } from '@bespokecore/core';

export type SessionPayload = Record<string, unknown>;

/**
 * Where session data lives (Laravel's session handlers): `file`, `database`, `redis`, `memory` and `cookie` implement
 * this contract (`stores/`).
 */
export interface SessionStore {
  read(id: string): Promise<SessionPayload | undefined>;
  /** Writes a session under an id that is new — a new session, or one `regenerate()`d at sign-in or sign-out. */
  write(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<void>;
  /**
   * Writes a session back only while it still exists — in ONE atomic step of the store, so a session another request
   * destroyed meanwhile (a sign-out or sign-in of the same browser, E45) stays destroyed. Returns whether it wrote:
   * false for a destroyed, expired or never written id. A regenerated id goes through `write`, never through this.
   * (The cookie store cannot know — it always writes, E46.)
   */
  writeIfExists(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<boolean>;
  destroy(id: string): Promise<void>;
  /** Removes expired sessions; returns how many (0 for stores that expire on their own: Redis, cookies). */
  gc(lifetimeSeconds: number): Promise<number>;
}
export const SessionStore = token<SessionStore>('SessionStore');

/** Session ids are 40 URL-safe characters — anything else is never looked up (no path tricks). */
export const SESSION_ID = /^[A-Za-z0-9_-]{40}$/;

/**
 * The session key holding the signed-in user's id (`@bespokecore/auth` writes it). The `database` store copies it into
 * the `user_id` column, so an app can list or end a user's sessions.
 */
export const SESSION_USER_KEY = '_auth_id';

export function createSessionId(): string {
  return crypto.getRandomValues(new Uint8Array(30)).toBase64({ alphabet: 'base64url' });
}

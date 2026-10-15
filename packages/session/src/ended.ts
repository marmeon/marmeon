import { hash } from 'node:crypto';

/**
 * The scope of a session: a hash of its id — never the id, which is a secret. It changes with every sign-in and
 * sign-out (the id is regenerated) and tells nothing about the session it came from. Once props are kept under it, and live
 * subscriptions are signed for it.
 */
export function sessionScope(id: string): string {
  return hash('sha256', `marmeon-once-scope:${id}`, 'base64url').slice(0, 22);
}

/**
 * The scope of an account: a hash of its id under a prefix of its own, so it never equals a {@link sessionScope}. It outlives every
 * sign-in of the account; it is an unkeyed hash and stays on the server. The live package files the account's streams under it.
 */
export function accountScope(userId: string | number): string {
  return hash('sha256', `marmeon-account-scope:${userId}`, 'base64url').slice(0, 22);
}

/** Told the scope of a session that ended. */
export type SessionEndedListener = (scope: string) => void | Promise<void>;

/**
 * Who wants to know when a session ends — signed out (`invalidate()`) or signed in (`regenerate()`): its old id is
 * destroyed when the request saves the session, and the listeners hear its scope ({@link sessionScope}). The live package closes
 * the streams of that session, in every process. One per application.
 */
export class SessionEndings {
  readonly #listeners = new Set<SessionEndedListener>();

  /** Listens; returns the function that stops it. */
  listen(listener: SessionEndedListener): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** @internal — `StartSession`, after it saved a session whose old id is gone. A listener that fails does not stop the others. */
  async ended(scope: string): Promise<void> {
    await Promise.allSettled([...this.#listeners].map(async (listener) => listener(scope)));
  }
}

import { hash } from 'node:crypto';

/**
 * The scope of a session: a hash of its id — never the id, which is a secret. It changes with every sign-in and
 * sign-out (the id is regenerated) and tells nothing about the session it came from. Once props derive their scope from it (with the page's locale), and live
 * subscriptions are signed for it. It is an unkeyed hash and stays on the server: whoever knows a session id can compute it, so it
 * proves nothing about who asks.
 */
export function sessionScope(id: string): string {
  return hash('sha256', `marmeon-once-scope:${id}`, 'base64url').slice(0, 22);
}

/**
 * The scope of an account: a hash of its id under a prefix of its own, so it never equals the scope of a session. It outlives every
 * sign-in of the account; it is an unkeyed hash and stays on the server. The live package files the account's streams under it.
 */
export function accountScope(userId: string | number): string {
  return hash('sha256', `marmeon-account-scope:${userId}`, 'base64url').slice(0, 22);
}

/** Told the scope of a session that ended. */
export type SessionEndedListener = (scope: string) => void | Promise<void>;

/**
 * Who wants to know when a session ends — signed out (`invalidate()`) or signed in (`regenerate()`): its old id is
 * destroyed when the request saves the session, and the listeners hear its scope (a hash of the session's id). The live package closes
 * the streams of that session, in every process. One per application.
 */
export class SessionEndings {
  readonly #listeners = new Set<SessionEndedListener>();
  readonly #accountListeners = new Set<SessionEndedListener>();

  /** Listens; returns the function that stops it. */
  listen(listener: SessionEndedListener): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /**
   * Listens for the sign-ins of an account that ended: the scope of the account (a hash of the account's id), or `'*'` for every
   * account. The live package closes the streams of that account, in every process. Returns the function that stops it.
   * @internal
   */
  listenAccounts(listener: SessionEndedListener): () => void {
    this.#accountListeners.add(listener);
    return () => void this.#accountListeners.delete(listener);
  }

  /** @internal — `AccountSessions`, `Auth`: the sign-ins of the account behind `scope` ended; a listener that fails does not stop the others. */
  async endAccount(scope: string): Promise<void> {
    await Promise.allSettled([...this.#accountListeners].map(async (listener) => listener(scope)));
  }

  /** @internal — `AccountSessions.endEveryone()`: the sign-ins of every account ended. */
  async endEverySession(): Promise<void> {
    await this.endAccount('*');
  }

  /** @internal — `StartSession`, after it saved a session whose old id is gone. A listener that fails does not stop the others. */
  async ended(scope: string): Promise<void> {
    await Promise.allSettled([...this.#listeners].map(async (listener) => listener(scope)));
  }
}

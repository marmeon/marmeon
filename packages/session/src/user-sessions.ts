import type { SessionStore } from './store.ts';

/**
 * The sessions of a user, as a whole — for an account that is deleted (`auth:prune-unverified`, a "delete my account"
 * page). A singleton: inject it anywhere, also in a command or a scheduled task.
 *
 * `end(id)` removes the user's sessions from a store that knows whose a session is (`database`: the `user_id` column). Every
 * other store keeps them until they expire — harmless for a deleted account: the guard of `@marmeon/auth` finds no user at their
 * next request and ends them then (and a new account that got the same id has another password fingerprint).
 *
 * It does not touch remember-me cookies, which sign the user in again. To end every session of an account that still exists,
 * remember-me cookies included, use `AccountSessions` of `@marmeon/auth`.
 */
export class UserSessions {
  readonly #store: () => SessionStore;

  /** `store`: the app's session store. */
  constructor(store: () => SessionStore) {
    this.#store = store;
  }

  /** Whether `end()` can find and delete a user's sessions: only the `database` driver can. */
  canEnd(): boolean {
    return this.#store().destroyUser !== undefined;
  }

  /** Ends every session of the user `id` the store can find — how many (0 when it cannot: file, Redis, memory). */
  async end(id: string | number): Promise<number> {
    const store = this.#store();
    return store.destroyUser ? store.destroyUser(String(id)) : 0;
  }
}

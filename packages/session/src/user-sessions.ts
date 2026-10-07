import type { SessionStore } from './store.ts';

/**
 * The sessions of a user, as a whole — for an account that is deleted (E203: `auth:prune-unverified`, a "delete my account"
 * page). A singleton: inject it anywhere, also in a command or a scheduled task.
 *
 * `end(id)` removes the user's sessions from a store that knows whose a session is (`database`: the `user_id` column). Every
 * other store keeps them until they expire — harmless for a deleted account: the guard of `@marmeon/auth` finds no user at their
 * next request and ends them then (and a new account that got the same id has another password fingerprint).
 */
export class UserSessions {
  readonly #store: (() => SessionStore) | undefined;

  /** `store`: the app's session store — none for the cookie driver (its sessions live in the browsers). */
  constructor(store: (() => SessionStore) | undefined) {
    this.#store = store;
  }

  /** Ends every session of the user `id` the store can find — how many (0 when it cannot: file, Redis, memory, cookie). */
  async end(id: string | number): Promise<number> {
    const store = this.#store?.();
    return store?.destroyUser ? store.destroyUser(String(id)) : 0;
  }
}

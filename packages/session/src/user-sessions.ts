import { afterCommit } from '@marmeon/core';
import { accountScope, type SessionEndings } from './ended.ts';
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
  readonly #endings: SessionEndings | undefined;

  /** `store`: the app's session store. `endings`: told that the account's sign-ins ended, so its open live streams close. */
  constructor(store: () => SessionStore, endings?: SessionEndings) {
    this.#store = store;
    this.#endings = endings;
  }

  /** Whether `end()` can find and delete a user's sessions: only the `database` driver can. */
  canEnd(): boolean {
    return this.#store().destroyUser !== undefined;
  }

  /** Ends every session of the user `id` the store can find — how many (0 when it cannot: file, Redis, memory). */
  async end(id: string | number): Promise<number> {
    const store = this.#store();
    try {
      return store.destroyUser ? await store.destroyUser(String(id)) : 0;
    } finally {
      // Whatever the store managed, the account's open live streams close and their browsers are checked again (a deleted account's are refused).
      // After the commit when called inside a transaction (account deletion): a stream that connects again must find the account gone.
      await afterCommit(() => this.#endings?.endAccount(accountScope(id)));
    }
  }
}

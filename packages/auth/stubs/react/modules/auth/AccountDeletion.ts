import { PasswordResetTokenStore } from '@marmeon/auth';
import { Clock, EventDispatcher } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { UserSessions } from '@marmeon/session';
import type { User } from './users.ts';
import { UserRepository } from './UserRepository.ts';

/**
 * An account was deleted — dispatched inside the deletion's transaction, once per account: a listener's writes join it
 * and go with it if it rolls back. Other modules listen to clear what belongs to the account (`listen(AccountDeleted, …)` in
 * their module); files go after the commit (`afterCommit`).
 */
export class AccountDeleted {
  readonly #event = true;
  /** The account as it was — its id, its address, whatever the row held (never the password hash). */
  readonly user: User;
  /** When it was deleted. */
  readonly at: Date;

  constructor(user: User, at: Date) {
    this.user = user;
    this.at = at;
  }
}

/**
 * The one way an account is deleted — by `auth:prune-unverified` and by any deletion the app adds (a "delete my account"
 * page): the row (its remember-me and API tokens go with it — the foreign keys cascade), its password reset token and what
 * other modules keep ({@link AccountDeleted}) in one transaction, then its sessions (`UserSessions`: the `database` driver
 * removes them; with the others they end at their next request, which finds no user). Irreversible.
 */
export class AccountDeletion {
  readonly #connections: Connections;
  readonly #users: UserRepository;
  readonly #resets: PasswordResetTokenStore;
  readonly #sessions: UserSessions;
  readonly #events: EventDispatcher;
  readonly #clock: Clock;

  constructor(connections: Connections, users: UserRepository, resets: PasswordResetTokenStore, sessions: UserSessions, events: EventDispatcher, clock: Clock) {
    this.#connections = connections;
    this.#users = users;
    this.#resets = resets;
    this.#sessions = sessions;
    this.#events = events;
    this.#clock = clock;
  }

  /**
   * Deletes the accounts `ids` — the deleted ones come back. `unconfirmedSince`: only those that never confirmed an address and were
   * made before then, decided in the statement that deletes (one confirmed a moment ago stays).
   */
  async delete(ids: readonly number[], only?: { unconfirmedSince: Date }): Promise<User[]> {
    if (ids.length === 0) return [];
    const now = new Date(this.#clock.now());
    const deleted = await this.#connections.transaction(async () => {
      const users = await this.#users.deleteAccounts(ids, only);
      for (const user of users) {
        await this.#resets.forget(user.email);
        await this.#events.dispatch(new AccountDeleted(user, now));
      }
      return users;
    });
    for (const user of deleted) await this.#sessions.end(user.id);
    return deleted;
  }
}

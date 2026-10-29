import { PasswordResetTokenStore } from '@marmeon/auth';
import { Clock, EventDispatcher } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { UserSessions } from '@marmeon/session';
import type { User } from './users.ts';
import { UserRepository } from './UserRepository.ts';

/**
 * An account is about to be deleted — dispatched inside the deletion's transaction, once per account, one account at a time:
 * the accounts before it in the same call (in the order of their ids) are already deleted, so a listener counts what is
 * left. A module that must not lose the account (the last administrator of a workspace) calls {@link AccountDeleting.refuse}
 * from its listener (`listen(AccountDeleting, …)`): that account stays, the others of the same call go on. Two deletions at
 * once see each other only through a lock — the listener locks the whole set it counts: its own table's membership rows, in a
 * fixed order, never `users` rows; see `docs/verification.md#unconfirmed-accounts`.
 */
export class AccountDeleting {
  readonly #event = true;
  readonly #reasons: string[] = [];
  /** The account as it is now. */
  readonly user: User;

  constructor(user: User) {
    this.user = user;
  }

  /** Keeps the account. `reason` is a sentence for a person — the app translates or shows it; it is no key. */
  refuse(reason: string): void {
    this.#reasons.push(reason);
  }

  /** The reasons the listeners gave, in the order they refused; empty when nobody refused. */
  get reasons(): readonly string[] {
    return this.#reasons;
  }
}

/** An account the deletion kept, and why — the reasons are those the listeners gave to {@link AccountDeleting.refuse}. */
export interface RefusedDeletion {
  readonly user: User;
  readonly reasons: readonly string[];
}

/** What {@link AccountDeletion.delete} did: the accounts it deleted and those a module refused to lose. */
export interface DeletionOutcome {
  readonly deleted: User[];
  readonly refused: RefusedDeletion[];
}

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
 * other modules keep ({@link AccountDeleted}) in one transaction (a module can refuse first: {@link AccountDeleting}), then its sessions (`UserSessions`: the `database` driver
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
   * Deletes the accounts `ids`. Each account is read with a lock; then, in id order and after the accounts before it are deleted,
   * the listeners of {@link AccountDeleting} are asked about it. One that a listener refuses stays, with its reasons in `refused`,
   * and the others go. `unconfirmedSince`: only those that never confirmed
   * an address and were made before then, decided in the statement that deletes (one confirmed a moment ago stays). A listener that
   * throws stops the call and rolls everything back: nothing is deleted.
   */
  async delete(ids: readonly number[], only?: { unconfirmedSince: Date }): Promise<DeletionOutcome> {
    if (ids.length === 0) return { deleted: [], refused: [] };
    const now = new Date(this.#clock.now());
    const { deleted, refused } = await this.#connections.transaction(async (): Promise<DeletionOutcome> => {
      const lock = this.#connections.options().driver === 'pgsql';
      const candidates = await this.#users.lockAccounts(ids, only, lock);
      const refused: RefusedDeletion[] = [];
      const deleted: User[] = [];
      // One account at a time, in id order: the question about an account comes after the accounts before it are gone, with
      // their cascades and their AccountDeleted listeners, so a listener that counts what is left counts what really is.
      for (const user of candidates) {
        const asking = new AccountDeleting(user);
        await this.#events.dispatch(asking);
        if (asking.reasons.length > 0) {
          refused.push({ user, reasons: [...asking.reasons] });
          continue;
        }
        for (const gone of await this.#users.deleteAccounts([user.id], only)) {
          await this.#resets.forget(gone.email);
          await this.#events.dispatch(new AccountDeleted(gone, now));
          deleted.push(gone);
        }
      }
      return { deleted, refused };
    });
    for (const user of deleted) await this.#sessions.end(user.id);
    return { deleted, refused };
  }
}

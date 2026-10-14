import { randomBytes } from 'node:crypto';
import { err, inTransaction, ok, type Result } from '@marmeon/core';
import type { UserSessions } from '@marmeon/session';
import type { RememberTokenStore } from './remember.ts';
import { UserProvider, type AuthUserId, type Credentials } from './user.ts';

/**
 * Stores a new random session key for the account `id`, so every session's fingerprint stops matching, and returns the
 * account's credentials with it — or `undefined` when the account is gone. Throws when the provider cannot store a key or does
 * not hand it back, since nobody would be signed out.
 */
export async function rotateSessionKey(users: UserProvider, id: string | number, caller: string): Promise<Credentials | undefined> {
  if (typeof users.updateSessionKey !== 'function') {
    throw new Error(
      `${caller} needs UserProvider.updateSessionKey(id, key): store the key in a column of the account ` +
        '(a session_key column) and hand it back as sessionKey from findById() and findForLogin().',
    );
  }
  const key = randomBytes(32).toString('base64url');
  await users.updateSessionKey(id as never, key);
  const credentials = await users.findById(id as never);
  if (credentials === undefined) return undefined;
  if (credentials.sessionKey !== key) {
    throw new Error(
      `${caller} stored a new key, but UserProvider.findById() does not hand it back as sessionKey — the other ` +
        'sessions would stay signed in. Return the session_key column as sessionKey from findById() and findForLogin().',
    );
  }
  return credentials;
}

/** What `AccountSessions.end()` did right away. */
export interface EndedSessions {
  /** How many sessions the store deleted at once (only the `database` driver can); the others end at their next request. */
  readonly removed: number;
}

/**
 * Ends every session and every remember-me cookie of one account, such as after an incident or an operator's reset. Inject it into
 * a command, a job or an admin controller. See `docs/authentication.md#ending-every-session-of-a-user`.
 */
export class AccountSessions {
  readonly #users: UserProvider;
  readonly #remember: RememberTokenStore;
  readonly #sessions: UserSessions | undefined;

  constructor(users: UserProvider, remember: RememberTokenStore, sessions: UserSessions | undefined) {
    this.#users = users;
    this.#remember = remember;
    this.#sessions = sessions;
  }

  /**
   * Forgets the account's remember-me tokens, replaces its session key, then deletes the sessions a store can find. Answers
   * `missing` when the id is not valid or no such account exists, with nothing written. Throws, naming the remedy, when the
   * `UserProvider` cannot store a session key: without one a running remember-me sign-in could outlive the call. Throws inside
   * a database transaction: each step commits on its own, and a rollback would bring the deleted tokens back.
   */
  async end(userId: AuthUserId): Promise<Result<EndedSessions, { readonly kind: 'missing' }>> {
    if (inTransaction()) {
      throw new Error('AccountSessions.end() must run outside a database transaction: each step commits on its own, and a rollback would bring the deleted remember-me tokens back.');
    }
    if (typeof this.#users.updateSessionKey !== 'function') {
      throw new Error(
        'AccountSessions.end() needs UserProvider.updateSessionKey(id, key) to end the sessions of every session driver: store the key in a ' +
          'column of the account (a session_key column) and hand it back as sessionKey from findById() and findForLogin().',
      );
    }
    const id = userId as string | number;
    if (id === '' || (typeof id === 'number' && !Number.isSafeInteger(id))) return err({ kind: 'missing' });
    if ((await this.#users.findById(id as never)) === undefined) return err({ kind: 'missing' });
    // The order is the invariant: tokens first, so that when a later step fails no remember-me cookie signs in again (and a
    // sign-in that is running finds its token gone); then the key, which ends the sessions of every driver; the store last, as a
    // tidy-up that frees the rows at once.
    await this.#remember.forgetUser(id);
    await rotateSessionKey(this.#users, id, 'AccountSessions.end()');
    const removed = (await this.#sessions?.end(id)) ?? 0;
    return ok({ removed });
  }
}

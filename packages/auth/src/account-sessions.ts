import { randomBytes } from 'node:crypto';
import { err, inTransaction, ok, type Result } from '@marmeon/core';
import type { UserSessions } from '@marmeon/session';
import type { RememberTokenStore } from './remember.ts';
import { UserProvider, type AuthUserId } from './user.ts';

/** The error for a claim on the account's row that failed while the session still fits the account: the provider's `updateSessionKey(id, k, k)` did not return `true`. */
export function claimRefused(caller: string): Error {
  return new Error(
    `${caller}: UserProvider.updateSessionKey(id, key, expected) returned false for the key the session holds, which is still the stored one. ` +
      'It must return true when key equals the stored key and expected matches it, even if no value changes (do not skip no-op writes or count only changed rows).',
  );
}

/** The error for a provider whose `updateSessionKey()` does not answer with a boolean (the old contract). */
export function notABoolean(caller: string): Error {
  return new Error(
    `${caller}: UserProvider.updateSessionKey(id, key, expected) must return whether it stored the key (compare-and-set: write only ` +
      'when the stored key equals expected, in one statement). See docs/authentication.md#signing-out-other-devices-without-a-password.',
  );
}

/**
 * Replaces the session key of the account `id` by a new random one, so every other session's fingerprint stops matching.
 * `expected` is a string or `null` (compare-and-set: only while the stored key is that, `conflict` otherwise), or `undefined` to
 * write regardless — only for ending every session of an account. Throws when the provider cannot store a key, answers with the
 * old contract (no boolean), or does not hand the column back from `findById()`, since nobody would be signed out.
 */
export async function rotateSessionKey(
  users: UserProvider,
  id: string | number,
  expected: string | null | undefined,
  caller: string,
): Promise<{ readonly kind: 'rotated'; readonly key: string } | { readonly kind: 'conflict' }> {
  if (typeof users.updateSessionKey !== 'function') {
    throw new Error(
      `${caller} needs UserProvider.updateSessionKey(id, key, expected): store the key in a column of the account ` +
        '(a session_key column) and hand it back as sessionKey from findById() and findForLogin().',
    );
  }
  const notReturned = () =>
    new Error(
      `${caller} stored a new key, but UserProvider.findById() does not hand it back as sessionKey — the other ` +
        'sessions would stay signed in. Return the session_key column as sessionKey from findById() and findForLogin().',
    );
  const key = randomBytes(32).toString('base64url');
  const stored: unknown = await users.updateSessionKey(id as never, key, expected);
  if (typeof stored !== 'boolean') throw notABoolean(caller);
  const credentials = await users.findById(id as never);
  if (!stored) {
    // Somebody else's key stands: the provider has to hand it back, or nothing here could tell a conflict from a lost write.
    if (credentials !== undefined && typeof credentials.sessionKey !== 'string') throw notReturned();
    return { kind: 'conflict' };
  }
  if (credentials === undefined) return { kind: 'rotated', key };
  // A string that is not ours is a later rotation by somebody else, which ends the sessions as well. The old key, or none, means
  // the provider said it wrote and did not (or does not hand the column back).
  if (typeof credentials.sessionKey !== 'string' || (expected === undefined ? credentials.sessionKey !== key : credentials.sessionKey === expected)) {
    throw notReturned();
  }
  return { kind: 'rotated', key };
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
        'AccountSessions.end() needs UserProvider.updateSessionKey(id, key, expected) to end the sessions of every session driver: store the key in a ' +
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
    // Written regardless of the stored key (`expected` undefined): a request replacing it at the same time cannot make this fail.
    // A request that checked its session against an older key cannot bind itself to this one (`Auth` anchors to what it verified).
    if ((await rotateSessionKey(this.#users, id, undefined, 'AccountSessions.end()')).kind === 'conflict') {
      if ((await this.#users.findById(id as never)) === undefined) return err({ kind: 'missing' });
      throw new Error('AccountSessions.end(): UserProvider.updateSessionKey(id, key, undefined) answered false for an account that exists — it must write regardless of the stored key.');
    }
    const removed = (await this.#sessions?.end(id)) ?? 0;
    return ok({ removed });
  }
}

import { randomBytes } from 'node:crypto';
import { type Clock, err, type EventDispatcher, inTransaction, type Logger, ok, type Result } from '@marmeon/core';
import type { SessionEndings, UserSessions } from '@marmeon/session';
import { withCode } from '@marmeon/core/internal';
import { accountScope } from '@marmeon/session/internal';
import { EverySessionEnded } from './events.ts';
import type { EmailChangeStore } from './email-changes.ts';
import type { PasswordResetTokenStore } from './password-reset.ts';
import type { SignInStore } from './sign-ins.ts';
import type { AccessTokenStore } from './tokens.ts';
import { idOf, UserProvider, type AuthUserId } from './user.ts';

/** The error for a claim on the account's row that failed while the session still fits the account: the provider's `updateSessionKey(id, k, k)` did not return `true`. */
export function claimRefused(caller: string): Error {
  return new Error(
    withCode(
      'A5',
      `${caller}: UserProvider.updateSessionKey(id, key, expected) returned false for the key the session holds, which is still the stored one. ` +
        'It must return true when key equals the stored key and expected matches it, even if no value changes (do not skip no-op writes or count only changed rows).',
    ),
  );
}

/** The error for a provider whose `updateSessionKey()` does not answer with a boolean (the old contract). */
export function notABoolean(caller: string): Error {
  return new Error(
    withCode(
      'A5',
      `${caller}: UserProvider.updateSessionKey(id, key, expected) must return whether it stored the key (compare-and-set: write only ` +
        'when the stored key equals expected, in one statement). See docs/authentication.md#signing-out-other-devices-without-a-password.',
    ),
  );
}

/** The error for a provider without `updateSessionKey()` — a JavaScript app or a cast; a TypeScript provider cannot leave it out. */
export function missingSessionKeyMethod(caller: string): Error {
  return new Error(
    withCode(
      'A5',
      `${caller} needs UserProvider.updateSessionKey(id, key, expected): store the key in a column of the account ` +
        '(a session_key column) and hand it back as sessionKey from findById() and findForSignIn().',
    ),
  );
}

/**
 * Whether the provider wrote: `answer` of `UserProvider.updatePasswordHash()`, which must be a boolean. Anything else is a provider
 * that does not say — it could put an old hash back over a reset that landed meanwhile, and nobody would know.
 */
export function passwordHashWritten(answer: unknown, caller: string): boolean {
  if (typeof answer === 'boolean') return answer;
  throw new Error(
    withCode(
      'A5',
      `${caller}: UserProvider.updatePasswordHash(id, hash, { expected, sessionKey }) must return whether it wrote the hash (compare-and-set: ` +
        'with expected, write only when the stored hash equals it, in one statement). See docs/authentication.md#for-your-own-user-provider.',
    ),
  );
}

/** The error for a password write whose new session key `findById()` does not hand back: the provider ignored `sessionKey`, so no other session would end. */
export function keyNotStored(caller: string): Error {
  return new Error(
    withCode(
      'A5',
      `${caller}: UserProvider.updatePasswordHash(id, hash, { sessionKey }) must store the session key in the same statement and findById() must hand it back as sessionKey — ` +
        'the other sessions would stay signed in. Nothing is changed where the write runs in a transaction.',
    ),
  );
}

/** The error for a write without `expected` that answered `false`: it must write regardless, so the account is gone or the provider is scoped. */
export function writeRefused(caller: string): Error {
  return new Error(
    withCode(
      'A5',
      `${caller}: UserProvider.updatePasswordHash(id, hash) answered false without expected: the account is gone, or the provider filters its UPDATE. ` +
        'It must write regardless of the stored hash. Nothing was changed.',
    ),
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
  if (typeof users.updateSessionKey !== 'function') throw missingSessionKeyMethod(caller);
  const notReturned = () =>
    new Error(
      withCode(
        'A5',
        `${caller} stored a new key, but UserProvider.findById() does not hand it back as sessionKey — the other ` +
          'sessions would stay signed in. Return the session_key column as sessionKey from findById() and findForSignIn().',
      ),
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

/** The error for a sign-in store without a method that ends sign-ins (JavaScript, a cast; a TypeScript store cannot leave it out). */
export function missingSignInMethod(caller: string, method: string): Error {
  return new Error(
    withCode(
      'A6',
      `${caller} needs SignInStore.${method}(): ending the sign-ins of an account ends their remember-me tokens with them. A store extends SignInStore and implements every method. ` +
        'Nothing was changed. See docs/authentication.md#your-own-stores.',
    ),
  );
}

/** The error for a change-of-address store without a method that drops changes (JavaScript, a cast; a TypeScript store cannot leave it out). */
export function missingEmailChangeMethod(caller: string, method: string): Error {
  return new Error(
    withCode(
      'A6',
      `${caller} needs EmailChangeStore.${method}(): a change of address a thief asked for must not outlive the end of the sessions or a new password. A store extends EmailChangeStore and implements every method. ` +
        'Nothing was changed. See docs/authentication.md#your-own-stores.',
    ),
  );
}

/** The key of `AccountSessions`' announcement that sign-ins ended — for `Auth`, not re-exported from the package. */
export const ANNOUNCE_ENDED = Symbol('announceEnded');

/** What `AccountSessions.end()` did right away. */
export interface EndedSessions {
  /** How many sessions the store deleted at once (only the `database` driver can); the others end at their next request. */
  readonly removed: number;
}

/** What `AccountSessions.endEveryone()` did. */
export interface EveryoneEnded {
  /** How many accounts got a new session key. */
  readonly accounts: number;
  /** How many password-reset tokens it deleted (0 when kept with `resetTokens: false`). */
  readonly resetTokens: number;
  /** How many API tokens it revoked (0 when kept with `accessTokens: false`). */
  readonly accessTokens: number;
  /** How many sign-ins it deleted, their remember-me tokens with them. */
  readonly signIns: number;
}

/**
 * Ends every session and every remember-me cookie of one account, such as after an incident or an operator's reset. Inject it into
 * a command, a job or an admin controller. With sign-ins switched on, their rows go too. See `docs/authentication.md#ending-every-session-of-a-user`.
 */
export class AccountSessions {
  readonly #users: UserProvider;
  readonly #signIns: SignInStore;
  readonly #sessions: UserSessions | undefined;
  readonly #events: EventDispatcher | undefined;
  readonly #clock: Clock | undefined;
  readonly #resets: (() => PasswordResetTokenStore) | undefined;
  readonly #access: (() => AccessTokenStore) | undefined;
  readonly #logger: Logger | undefined;
  readonly #endings: SessionEndings | undefined;
  readonly #changes: (() => EmailChangeStore | undefined) | undefined;

  /**
   * @internal Built by the container. Built by hand without the reset-token or API-token store, `endEveryone()` refuses unless it keeps them.
   * `changes` hands back the change-of-address store the app bound, or `undefined` when it bound none: the changes of the account go too.
   */
  constructor(
    users: UserProvider,
    signIns: SignInStore,
    sessions: UserSessions | undefined,
    events?: EventDispatcher,
    clock?: Clock,
    resets?: () => PasswordResetTokenStore,
    access?: () => AccessTokenStore,
    logger?: Logger,
    endings?: SessionEndings,
    changes?: () => EmailChangeStore | undefined,
  ) {
    this.#changes = changes;
    this.#users = users;
    this.#signIns = signIns;
    this.#sessions = sessions;
    this.#events = events;
    this.#clock = clock;
    this.#resets = resets;
    this.#access = access;
    this.#logger = logger;
    this.#endings = endings;
  }

  /**
   * @internal
   * Tells the live streams of the account that its sign-ins ended (they close, and the browsers still signed in connect again).
   * Tidying up after the real effect: a failure is logged, never thrown. Internal, like the sign-out of other devices: `Auth` calls it.
   */
  async [ANNOUNCE_ENDED](userId: string | number): Promise<void> {
    try {
      await this.#endings?.endAccount(accountScope(userId));
    } catch (error) {
      this.#logger?.error('The live streams of an account could not be told its sign-ins ended', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Ends the account's sign-ins (their remember-me tokens with them), replaces its session key, then deletes the sessions a store can find. Answers
   * `missing` when the id is not valid or no such account exists, with nothing written. Throws, naming the remedy, when the
   * `UserProvider` cannot store a session key: without one a running remember-me sign-in could outlive the call. Throws inside
   * a database transaction: each step commits on its own, and a rollback would bring the deleted tokens back.
   */
  async end(userId: AuthUserId): Promise<Result<EndedSessions, { readonly kind: 'missing' }>> {
    if (typeof this.#signIns.endAll !== 'function') throw missingSignInMethod('AccountSessions.end()', 'endAll');
    if (inTransaction()) {
      throw new Error('AccountSessions.end() must run outside a database transaction: each step commits on its own, and a rollback would bring the ended sign-ins back.');
    }
    if (typeof this.#users.updateSessionKey !== 'function') {
      throw missingSessionKeyMethod('AccountSessions.end()');
    }
    const changes = this.#changes?.();
    if (changes && typeof changes.forget !== 'function') throw missingEmailChangeMethod('AccountSessions.end()', 'forget');
    const id = userId as string | number;
    if (id === '' || (typeof id === 'number' && !Number.isSafeInteger(id))) return err({ kind: 'missing' });
    const found = await this.#users.findById(id as never);
    if (found === undefined) return err({ kind: 'missing' });
    // The order is the invariant: tokens first, so that when a later step fails no remember-me cookie signs in again (and a
    // sign-in that is running finds its token gone); then the key, which ends the sessions of every driver; the store last, as a
    // tidy-up that frees the rows at once.
    await this.#signIns.endAll(idOf(found.user));
    // Written regardless of the stored key (`expected` undefined): a request replacing it at the same time cannot make this fail.
    // A request that checked its session against an older key cannot bind itself to this one (`Auth` anchors to what it verified).
    if ((await rotateSessionKey(this.#users, id, undefined, 'AccountSessions.end()')).kind === 'conflict') {
      if ((await this.#users.findById(id as never)) === undefined) return err({ kind: 'missing' });
      throw new Error('AccountSessions.end(): UserProvider.updateSessionKey(id, key, undefined) answered false for an account that exists — it must write regardless of the stored key.');
    }
    // The key is rotated: every session is over, and the open streams close, whatever the tidying up below does.
    try {
      const removed = (await this.#sessions?.end(id)) ?? 0;
      // Rows a request made since the first `endAll()` (a sign-in that was running) go too; the key has ended their sessions already.
      await this.#signIns.endAll(idOf(found.user));
      // Last, after the key: every session is over whatever fails above, and a store that fails here leaves only this step to run again.
      await changes?.forget(idOf(found.user));
      return ok({ removed });
    } finally {
      await this[ANNOUNCE_ENDED](idOf(found.user)); // the account's own id, not the one the caller wrote
    }
  }

  /**
   * Ends every session of every account at once, such as after a leak: deletes every sign-in (the remember-me tokens with them), writes
   * one fresh session key into every account in a single statement, then deletes the sign-ins once more (one made in between) and the rest. Only the sign-ins go before the keys; the
   * rest follows them, so a store that fails never keeps a session alive. It also deletes every password-reset token and revokes
   * every API token, since a thief may hold either; `resetTokens: false` and `accessTokens: false` keep them. Each session of every driver and
   * instance ends at its next request. Throws, naming the remedy and before anything is deleted, when the `UserProvider` has no
   * `updateEverySessionKey()` or a store it will use lacks its `forgetEveryone()`/`revokeEveryone()` (JavaScript, a cast); throws when the
   * provider's `sampleId` account cannot be read back with the new key (a missing `sampleId` is an error too); throws inside a
   * database transaction, as `end()` does. A later failure leaves the earlier steps done (the error says which); calling again is safe. See
   * `docs/authentication.md#ending-every-session-of-every-account`.
   */
  async endEveryone({ accessTokens = true, resetTokens = true }: { readonly accessTokens?: boolean; readonly resetTokens?: boolean } = {}): Promise<EveryoneEnded> {
    if (inTransaction()) {
      throw new Error('AccountSessions.endEveryone() must run outside a database transaction: each step commits on its own, and a rollback would bring the ended sign-ins back.');
    }
    const users = this.#users;
    if (typeof users.updateEverySessionKey !== 'function') {
      throw new Error(
        withCode(
          'A5',
          'AccountSessions.endEveryone() needs UserProvider.updateEverySessionKey(key): write the key into the session_key column of every account ' +
            'with one UPDATE, and hand it back as sessionKey from findById() and findForSignIn().',
        ),
      );
    }
    // Every store this call will use is checked now: a store without the method (JavaScript, a cast) must refuse before anything is deleted.
    const refuse = (store: string, method: string, keep?: string) =>
      new Error(
        withCode(
          'A6',
          `AccountSessions.endEveryone() needs ${store}.${method}() — delete every row of the store in one statement${keep === undefined ? '' : `, or keep what it holds with ${keep}`}. Nothing was changed.`,
        ),
      );
    if (typeof this.#signIns.endEveryone !== 'function') throw refuse('SignInStore', 'endEveryone');
    const revokeResets = resetTokens;
    if (revokeResets && this.#resets === undefined) throw new Error('AccountSessions.endEveryone() needs the PasswordResetTokenStore, which the container passes in (or pass { resetTokens: false } to keep the reset tokens).');
    const resets = revokeResets ? this.#resets?.() : undefined;
    if (revokeResets && typeof resets?.forgetEveryone !== 'function') throw refuse('PasswordResetTokenStore', 'forgetEveryone', '{ resetTokens: false } (--keep-reset-tokens)');
    const changes = this.#changes?.();
    if (changes && typeof changes.forgetEveryone !== 'function') throw refuse('EmailChangeStore', 'forgetEveryone');
    const revokeAccess = accessTokens;
    const access = revokeAccess ? this.#access?.() : undefined;
    if (revokeAccess && typeof access?.revokeEveryone !== 'function') throw refuse('AccessTokenStore', 'revokeEveryone', '{ accessTokens: false } (--keep-api-tokens)');
    // The order is the invariant. Only the sign-ins go before the keys: no remember-me cookie may sign in again once a later
    // step fails (and a remember-me sign-in that is running finds its token gone). Then the keys, which end the sessions of every
    // driver and, by writing every account's row, hold back a second factor that is being stored (`CLAIM_ACCOUNT`) and end a waiting
    // second-factor step. Everything else follows the keys, so a store that cannot be emptied (a missing table) never keeps a session
    // alive. A step that fails leaves the ones before it done, and a second call finishes.
    const done: Record<string, number> = {};
    const later = [...(resets ? ['resetTokens'] : []), ...(access ? ['accessTokens'] : []), ...(changes ? ['emailChanges'] : [])];
    let keys: 'not-rotated' | 'unconfirmed' | 'rotated' = 'not-rotated';
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        const state = Object.keys(done).length === 0 ? 'nothing was changed yet' : `done: ${Object.entries(done).map(([key, count]) => `${key} ${count}`).join(', ')}`;
        const missing = later.filter((key) => !(key in done)).join(', ');
        const keysState =
          keys === 'rotated'
            ? `every session is already ended; still missing: ${missing}`
            : keys === 'unconfirmed'
              ? 'the keys were written but could not be confirmed'
              : 'the keys are NOT rotated, so every session is still live';
        const cause = error instanceof Error ? error.message : String(error);
        // A store that cannot be emptied fails the same way on every run: name the way out.
        const optOut =
          name === 'password-reset tokens'
            ? '; if that store cannot be emptied, keep the reset tokens with --keep-reset-tokens ({ resetTokens: false })'
            : name === 'API tokens'
              ? '; if that store cannot be emptied, keep the API tokens with --keep-api-tokens ({ accessTokens: false })'
              : '';
        const message = `AccountSessions.endEveryone() failed at "${name}" (${state}; ${keysState}): ${cause} — ${keys === 'unconfirmed' ? 'fix the UserProvider, then run it again' : 'run it again'}${optOut}.`;
        this.#logger?.error(message, { step: name, done, error: error instanceof Error ? error.message : String(error) });
        throw new Error(message, { cause: error });
      }
    };
    let signIns = (done.signIns = await step('sign-ins', () => this.#signIns.endEveryone()));
    const key = randomBytes(32).toString('base64url');
    // 'unconfirmed' too: the keys may have been written, and a stream that stays open is the worse mistake.
    const rotated = () => keys !== 'not-rotated';
    try {
      const accounts = await step('session keys', async () => {
        const written: unknown = await users.updateEverySessionKey!(key);
        keys = 'unconfirmed';
        const count = (written as { accounts?: unknown } | null | undefined)?.accounts;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
          throw new Error(withCode('A5', 'UserProvider.updateEverySessionKey(key) must return { accounts, sampleId }: how many accounts it wrote, as a count (a whole number, 0 or more).'));
        }
        const sampleId = (written as { sampleId?: unknown }).sampleId;
        if (sampleId === undefined) {
          if (count > 0) {
            throw new Error(withCode('A5', 'UserProvider.updateEverySessionKey(key) must return the id of one account it wrote (sampleId), so that the new key can be read back.'));
          }
        } else {
          const credentials = await users.findById(sampleId as never);
          if (credentials?.sessionKey !== key) {
            throw new Error(
              withCode(
                'A5',
                'cannot confirm the new key: UserProvider.updateEverySessionKey(key) wrote, but findById(sampleId) ' +
                  (credentials === undefined ? 'finds no account' : 'does not hand the new key back as sessionKey (is it cached, or not returned?)') +
                  ' — every session may still be live. findById() must return the session_key column as sessionKey, read after the write.',
              ),
            );
          }
        }
        keys = 'rotated';
        return count;
      });
      done.accounts = accounts;
      // Once more now that the keys are written: a sign-in that was running between the first pass and the keys made a row (and maybe a token), which no key ends.
      done.signIns = signIns += await step('sign-ins', () => this.#signIns.endEveryone());
      const revokedResets = (done.resetTokens = resets ? await step('password-reset tokens', () => resets.forgetEveryone!()) : 0);
      const revokedAccess = (done.accessTokens = access ? await step('API tokens', () => access.revokeEveryone!()) : 0);
      // Last: the opt-in store must not hold back the API tokens when it fails.
      if (changes) done.emailChanges = await step('changes of address', () => changes.forgetEveryone());
      const ended: EveryoneEnded = { accounts, resetTokens: revokedResets, accessTokens: revokedAccess, signIns };
      this.#logger?.warn('Ended every session of every account', { ...ended, emailChanges: done.emailChanges });
      // The work is done: a listener that fails must not make the caller run it again.
      try {
        await this.#events?.dispatch(new EverySessionEnded(ended, new Date(this.#clock?.now() ?? Date.now())));
      } catch (error) {
        this.#logger?.error('A listener of EverySessionEnded failed', { error: error instanceof Error ? error.message : String(error) });
      }
      return ended;
    } finally {
      // As soon as the keys are rotated every session is over, whatever a later step does: the open streams close either way.
      if (rotated()) {
        try {
          await this.#endings?.endEverySession();
        } catch (error) {
          this.#logger?.error('The live streams could not be told every sign-in ended', { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
}

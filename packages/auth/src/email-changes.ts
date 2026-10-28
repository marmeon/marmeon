import { createHash, randomBytes } from 'node:crypto';
import { Clock, ContainerError } from '@marmeon/core';
import { Connections, secretEquals, sql, type Secret } from '@marmeon/database';
import type { AuthUserId } from './user.ts';
import { withCode } from '@marmeon/core/internal';

/** The table the app's migration creates — see {@link EmailChangeTable}. */
export const EMAIL_CHANGES_TABLE = 'email_changes';

/**
 * The columns {@link DatabaseEmailChanges} needs: one row per account that has asked for a new address and not yet confirmed it. The
 * address in `email` is not the account's and signs nobody in; it lives here, not on `users`, so that no other module reads an address
 * its owner has not confirmed. The link's token is kept only as its SHA-256, a `secret()` column.
 */
export interface EmailChangeTable {
  user_id: number | string;
  email: string;
  token_hash: Secret<string>;
  /** The session key of the account when the change was asked for; the link works only while the account still holds it. */
  session_key: Secret<string | null>;
  expires_at: string | Date;
  created_at: string | Date;
}

/** The columns readiness waits for on `email_changes`. */
export const EMAIL_CHANGE_COLUMNS = ['user_id', 'email', 'token_hash', 'session_key', 'expires_at', 'created_at'] as const satisfies readonly (keyof EmailChangeTable)[];

/**
 * Changes of address that wait for their link: one per account, stored only as SHA-256 of the token (256 random bits need no slow hash),
 * used once, valid until they expire.
 *
 * Your own store extends this class and implements every method; none has a default, and a member added later has one only if it is
 * not security-relevant. See `docs/authentication.md#your-own-stores`.
 */
export abstract class EmailChangeStore {
  /** A mark without meaning: only a subclass fits the type, so a store that merely `implements` this contract does not compile. */
  readonly #contract = true;

  /** Refuses to be built itself: the container builds an unbound abstract key as an empty object, which would fail much later. */
  constructor() {
    if (new.target === EmailChangeStore) throw new ContainerError(withCode('K1', `EmailChangeStore is abstract: bind a store with container.singleton(EmailChangeStore, YourStore).`), { reason: 'unbound', key: 'EmailChangeStore', path: [] });
  }

  /**
   * Remembers that the account `userId` wants `email`, and returns the token for the link (32 random bytes, base64url). `sessionKey` is the
   * session key of the account that the asking session was checked against (`null`: the account has none): the change is stored only while
   * that key is still the account's, in one statement — a request that runs next to a new password or the end of the sessions cannot leave a
   * change behind. Answers `undefined`, storing nothing, when the key has changed. Replaces an older change of the account in the same
   * statement, so that two requests at once leave one change and the link of the older one dead. Only the SHA-256 of the token is stored.
   */
  abstract create(userId: AuthUserId, email: string, expiresAt: Date, sessionKey: string | null): Promise<string | undefined>;
  /** When the change expires, as long as `token` is the token of exactly this change of `userId` to `email` and has not expired; otherwise `undefined`. */
  abstract pending(userId: AuthUserId, email: string, token: string): Promise<Date | undefined>;
  /**
   * The address and expiry of the change `userId` has waiting, as long as it has not expired and the account still holds the session key it
   * was asked under (the same bindings as {@link pending}); otherwise `undefined`. It names no token: it tells what is waiting, not whether a
   * link is right. For a page that shows it and for a repeated request for the same address.
   */
  abstract waiting(userId: AuthUserId): Promise<{ readonly email: string; readonly expiresAt: Date } | undefined>;
  /**
   * Uses the change up and returns its address: only if `token` belongs to the change of `userId` and `now` is before its expiry. One
   * atomic step — of two requests with the same link at once, one gets the address and the other `undefined` — and `undefined` for a
   * malformed, unknown, foreign, used and expired token alike.
   */
  abstract claim(userId: AuthUserId, token: string, now: Date): Promise<string | undefined>;
  /** Drops the change of `userId`, if any — a new password, a reset and the end of its sessions do (a link a thief asked for must not outlive them). */
  abstract forget(userId: AuthUserId): Promise<void>;
  /** Deletes every change that expired by `now` — links nobody used (`marmeon auth:prune-tokens`). How many. */
  abstract prune(now: Date): Promise<number>;
  /** Deletes every change, valid or not (`AccountSessions.endEveryone()`): a link that was mailed before a leak must not work after it. How many. */
  abstract forgetEveryone(): Promise<number>;
}

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The default {@link EmailChangeStore}, on the app's `email_changes` table. */
export class DatabaseEmailChanges extends EmailChangeStore {
  readonly #connections: Connections;
  readonly #clock: Clock;
  readonly #users: string;

  /** `usersTable`: the table with the accounts' `id` and `session_key` columns (default `users`, a plain lower-case name). */
  constructor(connections: Connections, clock: Clock, options: { readonly usersTable?: string } = {}) {
    super();
    const usersTable = options.usersTable ?? 'users';
    if (!TABLE_NAME.test(usersTable)) throw new TypeError(`DatabaseEmailChanges: "${usersTable}" is not a plain table name (lower case letters, digits and underscores).`);
    this.#connections = connections;
    this.#clock = clock;
    this.#users = usersTable;
  }

  async create(userId: AuthUserId, email: string, expiresAt: Date, sessionKey: string | null): Promise<string | undefined> {
    const value = randomBytes(32).toString('base64url');
    const id = userId as string | number;
    const keyIs = sessionKey === null ? sql`session_key is null` : sql`session_key = ${sessionKey}`;
    // Checked in the statement that writes. A new password that lands meanwhile cannot make this a lasting change: `claim()` and `pending()`
    // compare the key kept in the row with the account's, so a change stored next to a key that is gone is dead. No row lock: it would
    // wait for the password's transaction, which deletes the change first and writes the account second.
    const result = await sql`
      insert into ${sql.id(EMAIL_CHANGES_TABLE)} (user_id, email, token_hash, session_key, expires_at, created_at)
      select ${id}, ${email}, ${sha256(value)}, session_key, ${expiresAt}, ${new Date(this.#clock.now())}
      from ${sql.id(this.#users)} where id = ${id} and ${keyIs}
      on conflict (user_id) do update set email = excluded.email, token_hash = excluded.token_hash, session_key = excluded.session_key, expires_at = excluded.expires_at, created_at = excluded.created_at`.execute(this.#db());
    return Number(result.numAffectedRows ?? 0) > 0 ? value : undefined;
  }

  async pending(userId: AuthUserId, email: string, value: string): Promise<Date | undefined> {
    if (!TOKEN.test(value)) return undefined; // malformed: no query
    const row = await this.#db()
      .selectFrom(EMAIL_CHANGES_TABLE)
      .select('expires_at')
      .where('user_id', '=', userId as string | number)
      .where('email', '=', email)
      .where((eb) => secretEquals(eb, 'token_hash', sha256(value)))
      .where(this.#keyHolds(userId as string | number))
      .where('expires_at', '>', new Date(this.#clock.now()))
      .executeTakeFirst();
    return row ? new Date(row.expires_at) : undefined;
  }

  async waiting(userId: AuthUserId): Promise<{ readonly email: string; readonly expiresAt: Date } | undefined> {
    const row = await this.#db()
      .selectFrom(EMAIL_CHANGES_TABLE)
      .select(['email', 'expires_at'])
      .where('user_id', '=', userId as string | number)
      .where(this.#keyHolds(userId as string | number))
      .where('expires_at', '>', new Date(this.#clock.now()))
      .executeTakeFirst();
    return row ? { email: row.email, expiresAt: new Date(row.expires_at) } : undefined;
  }

  async claim(userId: AuthUserId, value: string, now: Date): Promise<string | undefined> {
    if (!TOKEN.test(value)) return undefined; // malformed: no query
    // One statement decides: the row of this account, with this token, not expired — and it is gone with the answer.
    const row = await this.#db()
      .deleteFrom(EMAIL_CHANGES_TABLE)
      .where('user_id', '=', userId as string | number)
      .where((eb) => secretEquals(eb, 'token_hash', sha256(value)))
      .where(this.#keyHolds(userId as string | number))
      .where('expires_at', '>', now)
      .returning('email')
      .executeTakeFirst();
    return row?.email;
  }

  async forget(userId: AuthUserId): Promise<void> {
    await this.#db().deleteFrom(EMAIL_CHANGES_TABLE).where('user_id', '=', userId as string | number).execute();
  }

  async prune(now: Date): Promise<number> {
    return Number((await this.#db().deleteFrom(EMAIL_CHANGES_TABLE).where('expires_at', '<=', now).executeTakeFirst()).numDeletedRows);
  }

  async forgetEveryone(): Promise<number> {
    return Number((await this.#db().deleteFrom(EMAIL_CHANGES_TABLE).executeTakeFirst()).numDeletedRows);
  }

  /**
   * The account still holds the session key the change was asked under — the boundary that ends a link when the key is replaced by
   * anything (a sign-out of the other devices, a removed passkey), whether or not it called `forget()`. Compared in the statement that
   * deletes, as null-safe equality in a form both dialects take.
   */
  #keyHolds(id: string | number) {
    const users = sql.id(this.#users);
    const account = sql`(select ${users}.session_key from ${users} where ${users}.id = ${id})`;
    // An account that is gone holds no key, not even a null one.
    return sql<boolean>`(exists (select 1 from ${users} where ${users}.id = ${id}) and ((${sql.ref('session_key')} is null and ${account} is null) or ${sql.ref('session_key')} = ${account}))`;
  }

  #db() {
    return this.#connections.get<{ [EMAIL_CHANGES_TABLE]: EmailChangeTable }>();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

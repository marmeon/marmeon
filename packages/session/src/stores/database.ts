import { SystemClock, type Clock } from '@marmeon/core';
import type { Kysely } from '@marmeon/database';
import type { SessionStore, SessionWrite, SessionWriteResult, StoredSession } from '../store.ts';

/** The table `marmeon make:session-table` creates (E96: the app owns the migration; the store types it itself). */
export const SESSIONS_TABLE = 'sessions';

/** A connection of @marmeon/database. */
export interface DatabaseSessionConnection {
  readonly db: Kysely<any>;
}

type Sql = (typeof import('@marmeon/database'))['sql'];

/** What a table without the `version` column (made before W8 step 7) needs. */
const UPGRADE =
  'The sessions table has no version column: it was made before session keys were hashed and before writes compared versions. ' +
  'Run `marmeon make:session-table --upgrade` and `marmeon migrate` — every user is signed out once.';

/**
 * Sessions in the app's database (`SESSION_DRIVER=database`): a row per session in `sessions` — keyed by the SHA-256 of the
 * session id (`id`, E144), the payload as text in `payload` (JSON, or encrypted with `SESSION_ENCRYPT`), the signed-in user's
 * id in `user_id` (null for guests), the time of the last write in `last_activity` (epoch milliseconds) and a `version` that
 * goes up with every write. A session lives for the store's lifetime (`SESSION_LIFETIME`) after its last activity, like
 * Laravel's database handler.
 *
 * Writing back is ONE statement, `UPDATE … WHERE id = ? AND version = ? AND last_activity > ?` (compare-and-set, E145): a row a
 * sign-out deleted meanwhile — or another request wrote meanwhile — matches nothing, on Postgres and SQLite alike, across any
 * number of processes. A new session is `INSERT … ON CONFLICT DO NOTHING`: it never replaces a row.
 */
export class DatabaseSessionStore implements SessionStore {
  readonly #connection: () => Promise<DatabaseSessionConnection>;
  readonly #lifetime: number;
  readonly #clock: Clock;
  #sql: Promise<Sql> | undefined;

  /**
   * `connection`: resolved on first use — the store is built before the database package's provider boots.
   * `lifetimeSeconds`: how long a session lives after its last activity.
   */
  constructor(
    connection: DatabaseSessionConnection | (() => Promise<DatabaseSessionConnection>),
    lifetimeSeconds: number,
    clock: Clock = new SystemClock(),
  ) {
    this.#connection = typeof connection === 'function' ? connection : async () => connection;
    this.#lifetime = lifetimeSeconds;
    this.#clock = clock;
  }

  async read(key: string): Promise<StoredSession | undefined> {
    const { db, sql } = await this.#use();
    const { rows } = await upgradeHint(
      sql<{ payload: string; version: number | string }>`select payload, version from sessions where id = ${key} and last_activity > ${this.#oldest()}`.execute(db),
    );
    return rows[0] ? { data: rows[0].payload, version: Number(rows[0].version) } : undefined;
  }

  async write(key: string, data: string, { expectedVersion, userId = null }: SessionWrite): Promise<SessionWriteResult> {
    const { db, sql } = await this.#use();
    const now = this.#clock.now();
    if (expectedVersion === undefined) {
      const inserted = await upgradeHint(
        sql`insert into sessions (id, user_id, payload, last_activity, version) values (${key}, ${userId}, ${data}, ${now}, 1)
          on conflict (id) do nothing`.execute(db),
      );
      return inserted.numAffectedRows === 1n ? 'written' : 'conflict';
    }
    const updated = await upgradeHint(
      sql`update sessions set user_id = ${userId}, payload = ${data}, last_activity = ${now}, version = version + 1
        where id = ${key} and version = ${expectedVersion} and last_activity > ${this.#oldest()}`.execute(db),
    );
    if (updated.numAffectedRows === 1n) return 'written';
    // Nothing matched: written by another request since (conflict) — or destroyed, or expired (gone).
    const { rows } = await sql`select 1 as found from sessions where id = ${key} and last_activity > ${this.#oldest()}`.execute(db);
    return rows.length > 0 ? 'conflict' : 'gone';
  }

  async destroy(key: string): Promise<void> {
    const { db, sql } = await this.#use();
    await sql`delete from sessions where id = ${key}`.execute(db);
  }

  /** Every session of the user `userId` — a deleted account's (E203). */
  async destroyUser(userId: string): Promise<number> {
    const { db, sql } = await this.#use();
    const result = await sql`delete from sessions where user_id = ${userId}`.execute(db);
    return Number(result.numAffectedRows ?? 0n);
  }

  async gc(lifetimeSeconds: number): Promise<number> {
    const { db, sql } = await this.#use();
    const result = await sql`delete from sessions where last_activity <= ${this.#clock.now() - lifetimeSeconds * 1000}`.execute(db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /** Sessions whose last activity is at or before this have expired. */
  #oldest(): number {
    return this.#clock.now() - this.#lifetime * 1000;
  }

  async #use(): Promise<DatabaseSessionConnection & { sql: Sql }> {
    // Imported here, not at the top: @marmeon/database is an optional peer of the session.
    this.#sql ??= import('@marmeon/database').then((module) => module.sql);
    const [connection, sql] = await Promise.all([this.#connection(), this.#sql]);
    return { ...connection, sql };
  }
}

/** A query on a table without `version` fails with what to run (SQLite: "no such column", Postgres: "column … does not exist"). */
async function upgradeHint<T>(query: Promise<T>): Promise<T> {
  try {
    return await query;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/\bversion\b/.test(message) && /column/i.test(message)) throw new Error(UPGRADE, { cause: error });
    throw error;
  }
}

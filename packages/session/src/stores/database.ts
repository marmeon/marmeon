import { SystemClock, type Clock } from '@bespokecore/core';
import type { Kysely } from '@bespokecore/database';
import { SESSION_USER_KEY, type SessionPayload, type SessionStore } from '../store.ts';

/** The table `bespoke make:session-table` creates (E96: the app owns the migration; the store types it itself). */
export const SESSIONS_TABLE = 'sessions';

/** A connection of @bespokecore/database. */
export interface DatabaseSessionConnection {
  readonly db: Kysely<any>;
}

type Sql = (typeof import('@bespokecore/database'))['sql'];

/**
 * Sessions in the app's database (`SESSION_DRIVER=database`): a row per session in `sessions` — the data as JSON in
 * `payload`, the signed-in user's id in `user_id` (null for guests), the time of the last write in `last_activity`
 * (epoch milliseconds). A session lives for the store's lifetime (`SESSION_LIFETIME`) after its last activity, like
 * Laravel's database handler.
 *
 * Writing back is ONE statement, `UPDATE … WHERE id = ? AND last_activity > ?`: a row a sign-out deleted meanwhile
 * matches nothing, on Postgres and SQLite alike, across any number of processes.
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

  async read(id: string): Promise<SessionPayload | undefined> {
    const { db, sql } = await this.#use();
    const { rows } = await sql<{ payload: string }>`select payload from sessions where id = ${id} and last_activity > ${this.#oldest()}`.execute(db);
    return rows[0] ? (JSON.parse(rows[0].payload) as SessionPayload) : undefined;
  }

  async write(id: string, data: SessionPayload): Promise<void> {
    const { db, sql } = await this.#use();
    await sql`insert into sessions (id, user_id, payload, last_activity) values (${id}, ${userIdOf(data)}, ${JSON.stringify(data)}, ${this.#clock.now()})
      on conflict (id) do update set user_id = excluded.user_id, payload = excluded.payload, last_activity = excluded.last_activity`.execute(db);
  }

  async writeIfExists(id: string, data: SessionPayload): Promise<boolean> {
    const { db, sql } = await this.#use();
    const result = await sql`update sessions set user_id = ${userIdOf(data)}, payload = ${JSON.stringify(data)}, last_activity = ${this.#clock.now()}
      where id = ${id} and last_activity > ${this.#oldest()}`.execute(db);
    return result.numAffectedRows === 1n;
  }

  async destroy(id: string): Promise<void> {
    const { db, sql } = await this.#use();
    await sql`delete from sessions where id = ${id}`.execute(db);
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
    // Imported here, not at the top: @bespokecore/database is an optional peer of the session.
    this.#sql ??= import('@bespokecore/database').then((module) => module.sql);
    const [connection, sql] = await Promise.all([this.#connection(), this.#sql]);
    return { ...connection, sql };
  }
}

/** The signed-in user's id as text (ids may be numbers or strings), or null for a guest. */
function userIdOf(data: SessionPayload): string | null {
  const id = data[SESSION_USER_KEY];
  return typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint' ? String(id) : null;
}

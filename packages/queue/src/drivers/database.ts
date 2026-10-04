import { SystemClock, type Clock } from '@bespokecore/core';
import type { Kysely } from '@bespokecore/database';
import type { FailedJob, FailedJobStore, QueueCounts, QueuedPush, QueueDriver, ReservedJob } from '../driver.ts';

/** The tables `bespoke make:queue-table` creates (E96: the app owns the migration; the queue types them itself). */
export const JOBS_TABLE = 'jobs';
export const FAILED_JOBS_TABLE = 'failed_jobs';

/** A connection of @bespokecore/database — or a transaction of one (`queue.using(trx)`). */
export interface DatabaseQueueConnection {
  readonly db: Kysely<any>;
  readonly driver: 'sqlite' | 'pgsql';
  /** Whether the current call chain runs inside a `transaction()` of this connection (E107) — `db` then writes into it. */
  readonly inTransaction?: () => boolean;
  /**
   * Runs `work` in a transaction of its own on this connection (`connections.transaction()`, E107: `db` joins it) — for
   * steps that must happen together, like acknowledging a job and queuing the next of its chain. Without it, Kysely's
   * `db.transaction()` with its `trx`.
   */
  readonly transaction?: <R>(work: () => Promise<R>) => Promise<R>;
}

type Sql = (typeof import('@bespokecore/database'))['sql'];

async function use(connection: () => Promise<DatabaseQueueConnection>, cache: { sql?: Promise<Sql> }): Promise<DatabaseQueueConnection & { sql: Sql }> {
  // Imported here, not at the top: @bespokecore/database is an optional peer of the queue.
  cache.sql ??= import('@bespokecore/database').then((module) => module.sql);
  const [resolved, sql] = await Promise.all([connection(), cache.sql]);
  return { ...resolved, sql };
}

/**
 * Jobs in the app's database (`QUEUE_CONNECTION=database`, E83) — the table `jobs`.
 *
 * **The claim is one atomic statement across any number of workers:**
 * `UPDATE jobs … WHERE id = (SELECT id … LIMIT 1) RETURNING …` — on Postgres with `FOR UPDATE SKIP LOCKED` in the
 * subquery (a row another worker is claiming is skipped, never waited for, never taken twice); on SQLite as it is: a
 * write statement takes the database's single write lock before it reads (waiting with the busy timeout), so two
 * processes never claim the same row. (A `BEGIN` + `SELECT` + `UPDATE` would not be safe there — the read would come
 * before the lock.) A claim counts the attempt; `ack` deletes, `release` hands the row back —
 * both only while the claim is still this worker's (`attempts` unchanged), so a worker whose claim expired cannot
 * touch the job another worker holds now.
 *
 * A dispatch inside `connections.transaction()` on the same connection is part of that transaction (E85, E107): visible
 * to workers with the commit, gone with a rollback — as is one through `queue.using(trx)`.
 */
export class DatabaseQueueDriver implements QueueDriver {
  readonly #connection: () => Promise<DatabaseQueueConnection>;
  readonly #clock: Clock;
  readonly #retryAfter: number;
  readonly #cache: { sql?: Promise<Sql> } = {};

  /**
   * `connection`: resolved on first use (the driver is built before the database package boots).
   * `retryAfter`: seconds after which a claimed job counts as abandoned (its worker died) and is claimed again.
   */
  constructor(connection: DatabaseQueueConnection | (() => Promise<DatabaseQueueConnection>), options: { retryAfter: number; clock?: Clock }) {
    this.#connection = typeof connection === 'function' ? connection : async () => connection;
    this.#clock = options.clock ?? new SystemClock();
    this.#retryAfter = options.retryAfter;
  }

  /** The same driver, writing through `db` — a transaction: its dispatches commit or roll back with it. */
  using(db: Kysely<any>): DatabaseQueueDriver {
    const outer = this.#connection;
    return new DatabaseQueueDriver(async () => ({ db, driver: (await outer()).driver, inTransaction: () => true }), { retryAfter: this.#retryAfter, clock: this.#clock });
  }

  async joinsTransaction(): Promise<boolean> {
    return (await this.#connection()).inTransaction?.() ?? false;
  }

  async push(queue: string, payload: string, delay: number): Promise<string> {
    const { db, sql } = await use(this.#connection, this.#cache);
    return this.#insert(db, sql, { queue, payload, delay });
  }

  async #insert(db: Kysely<any>, sql: Sql, { queue, payload, delay }: QueuedPush): Promise<string> {
    const now = this.#clock.now();
    const { rows } = await sql<{ id: number | string }>`insert into jobs (queue, payload, attempts, reserved_at, available_at, created_at)
      values (${queue}, ${payload}, 0, null, cast(${now + Math.round(delay * 1000)} as bigint), cast(${now} as bigint)) returning id`.execute(db);
    return String(rows[0]!.id);
  }

  async reserve(queues: readonly string[]): Promise<ReservedJob | undefined> {
    const { db, sql, driver } = await use(this.#connection, this.#cache);
    for (const queue of queues) {
      const now = this.#clock.now();
      const expired = now - this.#retryAfter * 1000;
      const { rows } = await sql<{ id: number | string; queue: string; payload: string; attempts: number | string }>`update jobs
          set reserved_at = cast(${now} as bigint), attempts = attempts + 1
          where id = (
            select id from jobs
            where queue = ${queue} and ((reserved_at is null and available_at <= cast(${now} as bigint)) or reserved_at <= cast(${expired} as bigint))
            order by id
            limit 1 ${driver === 'pgsql' ? sql`for update skip locked` : sql``}
          )
          returning id, queue, payload, attempts`.execute(db);
      const row = rows[0];
      if (row) return { id: String(row.id), queue: row.queue, payload: row.payload, attempts: Number(row.attempts), reservedAt: now };
    }
    return undefined;
  }

  async ack(job: ReservedJob, next: readonly QueuedPush[] = []): Promise<boolean> {
    if (next.length === 0) return this.#delete(job);
    // The acknowledgement and the next job of the chain in ONE transaction: a crash (or a failed insert) between the two
    // would otherwise lose the rest of the chain — now the job stays claimed and runs again after retryAfter.
    const connection = await use(this.#connection, this.#cache);
    const handOff = async (db: Kysely<any>) => {
      if (!(await this.#delete(job, db))) return false;
      for (const push of next) await this.#insert(db, connection.sql, push);
      return true;
    };
    if (connection.inTransaction?.()) return handOff(connection.db);
    if (connection.transaction) return connection.transaction(() => handOff(connection.db));
    return connection.db.transaction().execute((trx) => handOff(trx));
  }

  async release(job: ReservedJob, delay: number): Promise<boolean> {
    const { db, sql } = await use(this.#connection, this.#cache);
    const result = await sql`update jobs set reserved_at = null, available_at = cast(${this.#clock.now() + Math.round(delay * 1000)} as bigint)
      where id = cast(${Number(job.id)} as bigint) and attempts = cast(${job.attempts} as integer) and reserved_at is not null`.execute(db);
    return result.numAffectedRows === 1n;
  }

  async fail(job: ReservedJob): Promise<boolean> {
    return this.#delete(job);
  }

  async size(queue: string): Promise<number> {
    const { db, sql } = await use(this.#connection, this.#cache);
    const { rows } = await sql<{ count: number | string }>`select count(*) as count from jobs where queue = ${queue}`.execute(db);
    return Number(rows[0]?.count ?? 0);
  }

  async counts(queue: string): Promise<QueueCounts> {
    const { db, sql } = await use(this.#connection, this.#cache);
    const now = this.#clock.now();
    const { rows } = await sql<{ ready: number | string | null; delayed: number | string | null; reserved: number | string | null }>`select
        sum(case when reserved_at is null and available_at <= cast(${now} as bigint) then 1 else 0 end) as ready,
        sum(case when reserved_at is null and available_at > cast(${now} as bigint) then 1 else 0 end) as delayed,
        sum(case when reserved_at is not null then 1 else 0 end) as reserved
      from jobs where queue = ${queue}`.execute(db);
    const row = rows[0];
    return { ready: Number(row?.ready ?? 0), delayed: Number(row?.delayed ?? 0), reserved: Number(row?.reserved ?? 0) };
  }

  async queues(): Promise<string[]> {
    const { db, sql } = await use(this.#connection, this.#cache);
    const { rows } = await sql<{ queue: string }>`select distinct queue from jobs order by queue`.execute(db);
    return rows.map((row) => row.queue);
  }

  async #delete(job: ReservedJob, through?: Kysely<any>): Promise<boolean> {
    const connection = await use(this.#connection, this.#cache);
    const { sql } = connection;
    const db = through ?? connection.db;
    const result = await sql`delete from jobs where id = cast(${Number(job.id)} as bigint) and attempts = cast(${job.attempts} as integer) and reserved_at is not null`.execute(db);
    return result.numAffectedRows === 1n;
  }
}

/** Failed jobs in `failed_jobs` (from `bespoke make:queue-table`). */
export class DatabaseFailedJobStore implements FailedJobStore {
  readonly #connection: () => Promise<DatabaseQueueConnection>;
  readonly #cache: { sql?: Promise<Sql> } = {};

  constructor(connection: DatabaseQueueConnection | (() => Promise<DatabaseQueueConnection>)) {
    this.#connection = typeof connection === 'function' ? connection : async () => connection;
  }

  async record(job: FailedJob): Promise<void> {
    const { db, sql } = await use(this.#connection, this.#cache);
    await sql`insert into failed_jobs (uuid, connection, queue, job, payload, exception, failed_at)
      values (${job.uuid}, ${job.connection}, ${job.queue}, ${job.job}, ${job.payload}, ${job.exception}, cast(${job.failedAt} as bigint))
      on conflict (uuid) do update set connection = excluded.connection, queue = excluded.queue, job = excluded.job,
        payload = excluded.payload, exception = excluded.exception, failed_at = excluded.failed_at`.execute(db);
  }

  async all(): Promise<FailedJob[]> {
    const { db, sql } = await use(this.#connection, this.#cache);
    const { rows } = await sql<Row>`select * from failed_jobs order by failed_at desc, uuid`.execute(db);
    return rows.map(fromRow);
  }

  async find(uuid: string): Promise<FailedJob | undefined> {
    const { db, sql } = await use(this.#connection, this.#cache);
    const { rows } = await sql<Row>`select * from failed_jobs where uuid = ${uuid}`.execute(db);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async forget(uuid: string): Promise<boolean> {
    const { db, sql } = await use(this.#connection, this.#cache);
    const result = await sql`delete from failed_jobs where uuid = ${uuid}`.execute(db);
    return result.numAffectedRows === 1n;
  }

  async flush(): Promise<number> {
    const { db, sql } = await use(this.#connection, this.#cache);
    const result = await sql`delete from failed_jobs`.execute(db);
    return Number(result.numAffectedRows ?? 0n);
  }

  async prune(before: number): Promise<number> {
    const { db, sql } = await use(this.#connection, this.#cache);
    const result = await sql`delete from failed_jobs where failed_at < cast(${before} as bigint)`.execute(db);
    return Number(result.numAffectedRows ?? 0n);
  }
}

interface Row {
  uuid: string;
  connection: string;
  queue: string;
  job: string;
  payload: string;
  exception: string;
  failed_at: number | string;
}

function fromRow(row: Row): FailedJob {
  return { uuid: row.uuid, connection: row.connection, queue: row.queue, job: row.job, payload: row.payload, exception: row.exception, failedAt: Number(row.failed_at) };
}

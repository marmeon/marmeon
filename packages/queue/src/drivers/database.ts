import { SystemClock, type Clock } from '@marmeon/core';
import type { Connection } from '@marmeon/database';
import type { FailedJob, FailedJobStore, QueueCounts, QueuedPush, QueueDriver, ReleaseOptions, ReservedJob } from '../driver.ts';
import { withAvailableAt } from '../driver.ts';

/** The tables `marmeon make:queue-table` creates (the app owns the migration; the queue types them itself). */
export const JOBS_TABLE = 'jobs';
export const FAILED_JOBS_TABLE = 'failed_jobs';

/** A connection of @marmeon/database — or a transaction of one (`queue.using(trx)`). */
export interface DatabaseQueueConnection {
  readonly db: Connection<any>;
  readonly driver: 'sqlite' | 'pgsql';
  /** Whether the current call chain runs inside a `transaction()` of this connection — `db` then writes into it. */
  readonly inTransaction?: () => boolean;
  /**
   * Runs `work` in a transaction of its own on this connection (`connections.transaction()`: `db` joins it) — for
   * steps that must happen together, like acknowledging a job and queuing the next of its chain. Without it, Kysely's
   * `db.transaction()` with its `trx`.
   */
  readonly transaction?: <R>(work: () => Promise<R>) => Promise<R>;
}

type Sql = (typeof import('@marmeon/database'))['sql'];

async function use(connection: () => Promise<DatabaseQueueConnection>, cache: { sql?: Promise<Sql> }): Promise<DatabaseQueueConnection & { sql: Sql }> {
  // Imported here, not at the top: @marmeon/database is an optional peer of the queue.
  cache.sql ??= import('@marmeon/database').then((module) => module.sql);
  const [resolved, sql] = await Promise.all([connection(), cache.sql]);
  return { ...resolved, sql };
}

/** The index the fair claim needs (`make:queue-table`'s migration creates it). */
export const FAIR_CLAIM_INDEX = 'jobs_reserved_at_available_at_id_index';

/**
 * The claim of `reserveAny`: one `UPDATE` whose row is the first of two subqueries — an expired claim (a worker died), else the
 * oldest due job — each `LIMIT 1` (`FOR UPDATE SKIP LOCKED` on Postgres), joined by `coalesce` (the second runs only when the
 * first found nothing). Not one `WHERE (reserved_at IS NULL AND available_at <= now) OR reserved_at <= expired`: an `OR` over
 * two ranges cannot walk one index in order, so both databases would read every due row and sort them. Both subqueries order
 * by all three columns of {@link FAIR_CLAIM_INDEX}: Postgres does not treat `reserved_at IS NULL` as an equality, so
 * `ORDER BY available_at, id` alone makes it sort again. Exported for the EXPLAIN test.
 */
export function claimAnyStatement(sql: Sql, driver: DatabaseQueueConnection['driver'], { now, expired, except }: { now: number; expired: number; except: readonly string[] }) {
  const lock = driver === 'pgsql' ? sql`for update skip locked` : sql``;
  const others = except.length === 0 ? sql`` : sql`and queue not in (${sql.join(except)})`;
  return sql<{ id: number | string; queue: string; payload: string; attempts: number | string }>`update jobs
      set reserved_at = cast(${now} as bigint), attempts = attempts + 1
      where id = coalesce(
        (select id from jobs where reserved_at <= cast(${expired} as bigint) ${others}
          order by reserved_at, available_at, id limit 1 ${lock}),
        (select id from jobs where reserved_at is null and available_at <= cast(${now} as bigint) ${others}
          order by reserved_at, available_at, id limit 1 ${lock})
      )
      returning id, queue, payload, attempts`;
}

/**
 * Jobs in the app's database (`QUEUE_CONNECTION=database`) — the table `jobs`.
 *
 * **The claim is one atomic statement across any number of workers:** `UPDATE jobs … WHERE id = (SELECT id … LIMIT 1)` —
 * on Postgres with `FOR UPDATE SKIP LOCKED` (a row another worker claims is skipped, never taken twice); on SQLite the write
 * statement takes the single write lock before it reads (a `BEGIN` + `SELECT` + `UPDATE` would read before the lock). A
 * claim counts the attempt; `ack` and `release` act only while the claim is still this worker's (`attempts` unchanged), so
 * a worker whose claim expired cannot touch the job another worker holds now. A worker without `--queue` claims with
 * `reserveAny` ({@link claimAnyStatement}). A dispatch inside `connections.transaction()` on the same connection is part
 * of that transaction.
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
  using(db: Connection<any>): DatabaseQueueDriver {
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

  async #insert(db: Connection<any>, sql: Sql, { queue, payload, delay }: QueuedPush): Promise<string> {
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

  /**
   * The oldest due job of every queue (but `except`) in ONE statement — an idle round asks the database once, whatever
   * the number of queues, and a queue that appears later is taken at once. Expired claims (a worker died) come first, then
   * jobs by when they became due. See {@link claimAnyStatement} for why the statement looks the way it does.
   */
  async reserveAny(except: readonly string[] = []): Promise<ReservedJob | undefined> {
    const { db, sql, driver } = await use(this.#connection, this.#cache);
    const now = this.#clock.now();
    const { rows } = await claimAnyStatement(sql, driver, { now, expired: now - this.#retryAfter * 1000, except }).execute(db);
    const row = rows[0];
    return row ? { id: String(row.id), queue: row.queue, payload: row.payload, attempts: Number(row.attempts), reservedAt: now } : undefined;
  }

  async ack(job: ReservedJob, next: readonly QueuedPush[] = []): Promise<boolean> {
    if (next.length === 0) return this.#delete(job);
    // The acknowledgement and the next job of the chain in ONE transaction: a crash (or a failed insert) between the two
    // would otherwise lose the rest of the chain; this way the job stays claimed and runs again after retryAfter.
    const connection = await use(this.#connection, this.#cache);
    const handOff = async (db: Connection<any>) => {
      if (!(await this.#delete(job, db))) return false;
      for (const push of next) await this.#insert(db, connection.sql, push);
      return true;
    };
    if (connection.inTransaction?.()) return handOff(connection.db);
    if (connection.transaction) return connection.transaction(() => handOff(connection.db));
    return connection.db.transaction().execute((trx) => handOff(trx));
  }

  async release(job: ReservedJob, delay: number, options: ReleaseOptions = {}): Promise<boolean> {
    const { db, sql } = await use(this.#connection, this.#cache);
    const attempts = options.refund ? job.attempts - 1 : job.attempts;
    const result = await sql`update jobs set reserved_at = null, available_at = cast(${this.#clock.now() + Math.round(delay * 1000)} as bigint),
      attempts = cast(${attempts} as integer), payload = ${options.availableAt === undefined ? job.payload : withAvailableAt(job.payload, options.availableAt)}
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

  async #delete(job: ReservedJob, through?: Connection<any>): Promise<boolean> {
    const connection = await use(this.#connection, this.#cache);
    const { sql } = connection;
    const db = through ?? connection.db;
    const result = await sql`delete from jobs where id = cast(${Number(job.id)} as bigint) and attempts = cast(${job.attempts} as integer) and reserved_at is not null`.execute(db);
    return result.numAffectedRows === 1n;
  }
}

/** Failed jobs in `failed_jobs` (from `marmeon make:queue-table`). */
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

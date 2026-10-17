import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { withCode } from '@marmeon/core/internal';
import type { Kysely } from 'kysely';
import { isUniqueViolation } from '../errors.ts';
import { importPg } from '../postgres.ts';

/** SQLite: the table whose one row is the lock. Postgres needs none — it holds an advisory lock on a connection. */
export const LOCK_TABLE = 'marmeon_migration_lock';

/** The row of {@link LOCK_TABLE} that stands for "a migration is running". */
const LOCK_NAME = 'migrations';

/** Postgres: the advisory lock's key ("MMNMIGR" in ASCII), one 64-bit number for every Marmeon app on the database. */
export const ADVISORY_KEY = 0x4d4d4e4d_4d494752n;
const KEY_HIGH = Number(ADVISORY_KEY >> 32n);
const KEY_LOW = Number(ADVISORY_KEY & 0xffffffffn);

/** Prefix of the connection's `application_name` while it holds the Postgres lock: how a waiter learns who holds it. */
const NAME_PREFIX = 'marmeon-migrate:';

/** A SQLite lock whose holder has not shown a sign of life for this long belongs to a process that died. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

const POLL_MS = 200;

/**
 * `hostname:pid`, and on Linux `#<pid namespace>`: containers can share a hostname (`network_mode: host`) and still have pid
 * namespaces of their own, in which a pid proves nothing about another container's process.
 */
export function ownerOf(pid: number): string {
  let namespace = '';
  try {
    namespace = `#${/\d+/.exec(readlinkSync('/proc/self/ns/pid'))?.[0] ?? ''}`;
  } catch {
    // no /proc (macOS): the host and the pid have to do
  }
  return `${hostname()}:${pid}${namespace === '#' ? '' : namespace}`;
}

/** Who holds the lock, and since when. */
export interface LockHolder {
  /** `hostname:pid`, or `unknown` when the database does not tell. */
  readonly owner: string;
  readonly since: Date | undefined;
  /** SQLite: when the lock counts as abandoned if its holder shows no sign of life until then. */
  readonly staleAt?: Date | undefined;
}

/**
 * Another migration holds the lock and did not let go within the time to wait. `marmeon migrate` and its siblings exit with 1
 * and this message. See `docs/migrations.md#one-migration-at-a-time`.
 */
export class MigrationLockTimeoutError extends Error {
  readonly holder: LockHolder;

  constructor(holder: LockHolder) {
    super(
      withCode('D8', `Another migration has run since ${holder.since?.toISOString() ?? 'an unknown time'} (${holder.owner}). ` +
        (holder.staleAt
          ? `If its process is gone, the lock counts as abandoned from ${holder.staleAt.toISOString()} (ten minutes after its last sign of life; at once when it ran on this host). `
          : 'If its process is gone, the lock is free as soon as the database notices. ') +
        'Otherwise wait for it, or raise --wait=<seconds>.'),
    );
    this.name = 'MigrationLockTimeoutError';
    this.holder = holder;
  }
}

/**
 * The migration lost its lock while it ran: its database connection ended (Postgres) or another migration took the lock over
 * (SQLite). The run stops before the next migration; check what the database holds before migrating again.
 */
export class MigrationLockLostError extends Error {
  constructor(reason: string) {
    super(`The migration lock was lost: ${reason}. The run stops here; look at the database before migrating again.`);
    this.name = 'MigrationLockLostError';
  }
}

/** A lock that is held. */
export interface HeldLock {
  /** Lets go. */
  release(): Promise<void>;
  /**
   * Shows the holder is alive, and throws {@link MigrationLockLostError} when it no longer holds the lock. The migrator calls it
   * inside the transaction that writes its record (`on`), so a lock lost meanwhile rolls that transaction back.
   */
  heartbeat(on?: Kysely<any>): Promise<void>;
}

export interface LockOptions {
  readonly driver: 'sqlite' | 'pgsql';
  /** Postgres: the URL the lock's own connection opens (the app's pool is not used). */
  readonly url?: string;
  /** Postgres: the connection's name, for the message when `pg` is missing. */
  readonly connection?: string;
  /** How long to wait for another migration to end (default 60). `0` tries once. */
  readonly waitSeconds?: number;
  /** A SQLite lock that was taken over from a dead process. */
  readonly onTakeover?: (previous: LockHolder) => void;
  /** The clock — replaced in tests. */
  readonly now?: () => Date;
  /** `hostname:pid` — replaced in tests. */
  readonly owner?: string;
}

/**
 * Lets one migration at a time run on a database. Postgres: `pg_advisory_lock` on a connection of its own (outside the app's
 * pool), in a transaction that stays open for the run and ends with it or with the connection (a crashed process lets go). SQLite: a row in {@link LOCK_TABLE} with a heartbeat; a row
 * nobody has refreshed for {@link STALE_AFTER_MS}, or whose process on this host is gone, is taken over with a warning. See
 * `docs/migrations.md#one-migration-at-a-time`.
 */
export const MigrationLock = {
  async acquire(db: Kysely<any>, options: LockOptions): Promise<HeldLock> {
    const owner = options.owner ?? ownerOf(process.pid);
    const waitMs = (options.waitSeconds ?? 60) * 1000;
    if (options.driver === 'pgsql') return acquirePostgres(options, owner, waitMs);
    return acquireSqlite(db, owner, waitMs, options.now ?? (() => new Date()), options.onTakeover);
  },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function acquirePostgres(options: LockOptions, owner: string, waitMs: number): Promise<HeldLock> {
  if (options.url === undefined) throw new TypeError('The Postgres migration lock needs the connection’s url.');
  const pg = await importPg(undefined, options.connection);
  const client = new pg.Client({ connectionString: options.url, keepAlive: true });
  let lost: MigrationLockLostError | undefined;
  // Without a listener an ended connection would crash the process with an unrelated message.
  client.on('error', (error) => {
    lost ??= new MigrationLockLostError(`its database connection ended (${error.message})`);
  });
  await client.connect();
  const key = String(ADVISORY_KEY);
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      // A transaction lock in a transaction that stays open for the whole run: the open transaction pins the server connection,
      // also behind a connection pooler in transaction mode, where a session lock would be let go (or shared, as it is re-entrant).
      await client.query('begin');
      await client.query(`select set_config('application_name', $1, true)`, [NAME_PREFIX + owner]);
      const row = (await client.query<{ locked: boolean }>('select pg_try_advisory_xact_lock($1::bigint) as locked', [key])).rows[0];
      if (row?.locked) break;
      await client.query('rollback');
      if (Date.now() >= deadline) throw new MigrationLockTimeoutError(await postgresHolder(client));
      await sleep(POLL_MS);
    }
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return {
    release: async () => {
      try {
        if (!lost) await client.query('rollback');
      } finally {
        await client.end().catch(() => {});
      }
    },
    // The connection being alive is not enough: ask whether this backend still holds the lock.
    heartbeat: async () => {
      if (lost) throw lost;
      let held: unknown[];
      try {
        held = (
          await client.query(
            `select 1 from pg_locks where pid = pg_backend_pid() and locktype = 'advisory' and granted
             and classid = ${KEY_HIGH}::oid and objid = ${KEY_LOW}::oid and objsubid = 1`,
          )
        ).rows;
      } catch (error) {
        throw lost ?? new MigrationLockLostError(`its database connection ended (${(error as Error).message})`);
      }
      if (held.length === 0) throw new MigrationLockLostError('the database no longer holds it for this connection');
    },
  };
}

async function postgresHolder(client: { query<R>(text: string): Promise<{ rows: R[] }> }): Promise<LockHolder> {
  const result = await client.query<{ application_name: string; xact_start: Date | string | null }>(`
    select a.application_name, a.xact_start from pg_locks l join pg_stat_activity a on a.pid = l.pid
    where l.locktype = 'advisory' and l.granted and l.database = (select oid from pg_database where datname = current_database())
      and l.classid = ${KEY_HIGH}::oid and l.objid = ${KEY_LOW}::oid and l.objsubid = 1 and a.pid <> pg_backend_pid()
    limit 1`);
  const row = result.rows[0];
  const owner = row?.application_name.startsWith(NAME_PREFIX) ? row.application_name.slice(NAME_PREFIX.length) : 'unknown';
  return { owner, since: row?.xact_start ? new Date(row.xact_start) : undefined };
}

interface LockRow {
  name: string;
  owner: string;
  acquired_at: string;
  heartbeat_at: string;
}

/** The database is locked by another connection for longer than the driver waits (SQLite `SQLITE_BUSY`). */
function isBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { errcode, message } = error as { errcode?: unknown; message?: unknown };
  return errcode === 5 || (typeof message === 'string' && /database is locked/i.test(message));
}

/** Whether `owner` (see {@link ownerOf}) ran on this host, in this pid namespace, and its process no longer exists. */
function processIsGone(owner: string): boolean {
  const match = /^(.+):(\d+)(?:#(\d+))?$/.exec(owner);
  if (!match) return false;
  const [, host, pid, namespace] = match;
  const mine = /^(.+):(\d+)(?:#(\d+))?$/.exec(ownerOf(process.pid));
  if (host !== hostname() || namespace !== mine?.[3]) return false;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function acquireSqlite(
  db: Kysely<any>,
  owner: string,
  waitMs: number,
  now: () => Date,
  onTakeover: ((previous: LockHolder) => void) | undefined,
): Promise<HeldLock> {
  const deadline = now().getTime() + waitMs;
  let known: LockHolder = { owner: 'unknown', since: undefined };
  let acquiredAt: string | undefined;
  while (acquiredAt === undefined) {
    try {
      acquiredAt = await tryAcquire();
    } catch (error) {
      // Another connection holds the database's write lock (a migration's transaction): that is the lock being held, too.
      if (!isBusy(error)) throw error;
    }
    if (acquiredAt !== undefined) break;
    if (now().getTime() >= deadline) throw new MigrationLockTimeoutError(known);
    await sleep(POLL_MS);
  }
  let mine = acquiredAt;
  return {
    release: async () => {
      await db.deleteFrom(LOCK_TABLE).where('name', '=', LOCK_NAME).where('acquired_at', '=', mine).execute();
    },
    heartbeat: async (on = db) => {
      const beat = now().toISOString();
      const result = await on.updateTable(LOCK_TABLE).set({ heartbeat_at: beat }).where('name', '=', LOCK_NAME).where('acquired_at', '=', mine).executeTakeFirst();
      if (result.numUpdatedRows === 0n) throw new MigrationLockLostError('another migration took it over');
    },
  };

  /** The stamp of our row when the lock is ours now, undefined while another migration holds it. */
  async function tryAcquire(): Promise<string | undefined> {
    await createLockTable(db);
    const stamp = now().toISOString();
    try {
      await db.insertInto(LOCK_TABLE).values({ name: LOCK_NAME, owner, acquired_at: stamp, heartbeat_at: stamp }).execute();
      return stamp;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const row = (await db.selectFrom(LOCK_TABLE).selectAll().where('name', '=', LOCK_NAME).executeTakeFirst()) as LockRow | undefined;
    if (row === undefined) return undefined; // the holder let go between our insert and our select: try again
    const staleAt = new Date(new Date(row.heartbeat_at).getTime() + STALE_AFTER_MS);
    known = { owner: row.owner, since: new Date(row.acquired_at), staleAt };
    if (now() < staleAt && !processIsGone(row.owner)) return undefined;
    const taken = now().toISOString();
    // Compare and swap: of several waiters that find the same dead row, one takes it.
    const swapped = await db
      .updateTable(LOCK_TABLE)
      .set({ owner, acquired_at: taken, heartbeat_at: taken })
      .where('name', '=', LOCK_NAME)
      .where('acquired_at', '=', row.acquired_at)
      .where('heartbeat_at', '=', row.heartbeat_at)
      .executeTakeFirst();
    if (swapped.numUpdatedRows === 0n) return undefined;
    onTakeover?.(known);
    return taken;
  }
}

async function createLockTable(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable(LOCK_TABLE)
    .ifNotExists()
    .addColumn('name', 'varchar(255)', (c) => c.primaryKey())
    .addColumn('owner', 'varchar(255)', (c) => c.notNull())
    .addColumn('acquired_at', 'varchar(32)', (c) => c.notNull())
    .addColumn('heartbeat_at', 'varchar(32)', (c) => c.notNull())
    .execute();
}

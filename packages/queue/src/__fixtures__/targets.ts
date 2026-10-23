import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CACHE_MIGRATION } from '@marmeon/cache/internal';
import type { Clock, Logger } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, sql, type ConnectionOptions, type Migration } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { RedisConnections } from '@marmeon/redis';
import { QUEUE_MIGRATION } from '../commands/failed.ts';
import type { FailedJobStore, QueueDriver } from '../driver.ts';
import { DatabaseFailedJobStore, DatabaseQueueDriver } from '../drivers/database.ts';
import { MemoryFailedJobStore, MemoryQueueDriver } from '../drivers/memory.ts';
import { RedisQueueDriver } from '../drivers/redis.ts';

/** Postgres runs when `MARMEON_TEST_PGSQL_URL` is set (`pnpm test:pgsql`), Redis when `MARMEON_TEST_REDIS_URL` is (`pnpm test:redis`). */
export const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
export const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL;

export const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/**
 * Where a queue keeps its jobs — enough for another process to open the same one. A Redis queue keeps the rest (the
 * fixture's `handled` table, failed jobs) in a SQLite file.
 */
export type QueueTarget = { kind: 'memory' } | { kind: 'sqlite'; file: string } | { kind: 'pgsql'; url: string } | { kind: 'redis'; url: string; prefix: string; file: string };
export type QueueKind = QueueTarget['kind'];
/** A target worker processes can share. */
export type SharedTarget = Exclude<QueueTarget, { kind: 'memory' }>;

/** Every driver the suite runs against: memory and SQLite always, Postgres and Redis with their URLs. */
export const queueKinds: readonly QueueKind[] = ['memory', 'sqlite', ...(PGSQL_URL ? (['pgsql'] as const) : []), ...(REDIS_URL ? (['redis'] as const) : [])];
/** The database drivers (what the transactions of the database queue need). */
export const databaseKinds: readonly Exclude<QueueKind, 'memory' | 'redis'>[] = ['sqlite', ...(PGSQL_URL ? (['pgsql'] as const) : [])];
/** The drivers real `queue:work` processes run against (one suite for all). */
export const processKinds: readonly SharedTarget['kind'][] = [...databaseKinds, ...(REDIS_URL ? (['redis'] as const) : [])];

export function databaseConnections(options: ConnectionOptions): Connections {
  return new Connections({ connections: { default: { ...options, managed: false } }, root: '/', logger: silent });
}

/** The database of a target — for a Redis queue, the SQLite file beside it. */
export function connectionOptions(target: SharedTarget, poolMax = 5): ConnectionOptions {
  return target.kind === 'pgsql' ? { driver: 'pgsql', url: target.url, poolMax } : { driver: 'sqlite', database: target.file };
}

export function redisConnections(url: string, prefix: string): RedisConnections {
  return new RedisConnections({ connections: { default: { url, prefix } }, logger: silent });
}

/** Runs the queue migration (the file `make:queue-table` copies), the cache's (locks) and the fixture table `handled`. */
export async function migrate(connections: Connections): Promise<void> {
  for (const file of [QUEUE_MIGRATION, CACHE_MIGRATION]) await runMigration(connections, ((await import(file.href)) as { default: Migration }).default);
  await runMigration(connections, {
    up: (schema) =>
      schema.create('handled', (table) => {
        table.string('uuid', 64);
        table.integer('n');
        table.integer('attempt');
        table.integer('pid');
        table.string('event');
        table.bigInteger('at').nullable();
      }),
  });
}

/** A fresh, empty, migrated target (a new SQLite file or Postgres database). */
export async function freshTarget(kind: QueueKind): Promise<{ target: QueueTarget; drop: () => Promise<void> }> {
  switch (kind) {
    case 'memory':
      return { target: { kind }, drop: async () => {} };
    case 'sqlite':
    case 'redis': {
      const directory = mkdtempSync(join(tmpdir(), 'marmeon-queue-'));
      const file = join(directory, 'queue.sqlite');
      const connections = databaseConnections({ driver: 'sqlite', database: file });
      await migrate(connections);
      await connections.destroy();
      const removeFile = async () => rmSync(directory, { recursive: true, force: true });
      if (kind === 'sqlite') return { target: { kind, file }, drop: removeFile };
      const prefix = `marmeon-queue-test-${crypto.randomUUID().slice(0, 8)}:`;
      return {
        target: { kind, url: REDIS_URL!, prefix, file },
        drop: async () => {
          const redis = redisConnections(REDIS_URL!, prefix);
          const keys = await redis.get().command<string[]>(['KEYS', `${prefix}*`]);
          if (keys.length > 0) await redis.get().command(['DEL', ...keys]);
          await redis.close();
          await removeFile();
        },
      };
    }
    case 'pgsql': {
      const name = `marmeon_queue_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const admin = databaseConnections({ driver: 'pgsql', url: PGSQL_URL! });
      await sql`create database ${sql.id(name)}`.execute(admin.get());
      const url = new URL(PGSQL_URL!);
      url.pathname = `/${name}`;
      const connections = databaseConnections({ driver: 'pgsql', url: url.href, poolMax: 2 });
      await migrate(connections);
      await connections.destroy();
      return {
        target: { kind, url: url.href },
        drop: async () => {
          await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
          await admin.destroy();
        },
      };
    }
  }
}

/** A queue under test: its driver and failed store on a fresh target, a test clock, and its connections (database kinds). */
export interface QueueUnderTest {
  readonly driver: QueueDriver;
  readonly failed: FailedJobStore;
  readonly clock: TestClock;
  readonly target: QueueTarget;
  readonly connections: Connections | undefined;
  close(): Promise<void>;
}

export async function queueUnderTest(kind: QueueKind, options: { retryAfter?: number } = {}): Promise<QueueUnderTest> {
  const { target, drop } = await freshTarget(kind);
  const clock = new TestClock();
  const retryAfter = options.retryAfter ?? 90;
  if (target.kind === 'memory') {
    return { driver: new MemoryQueueDriver({ clock, retryAfter }), failed: new MemoryFailedJobStore(), clock, target, connections: undefined, close: drop };
  }
  const connections = databaseConnections(connectionOptions(target));
  const connection = { db: connections.get(), driver: connections.options().driver };
  const redis = target.kind === 'redis' ? redisConnections(target.url, target.prefix) : undefined;
  return {
    driver: redis ? new RedisQueueDriver(redis.get(), { retryAfter, clock: clock as Clock }) : new DatabaseQueueDriver(connection, { retryAfter, clock: clock as Clock }),
    failed: new DatabaseFailedJobStore(connection),
    clock,
    target,
    connections,
    close: async () => {
      await redis?.close();
      await connections.destroy();
      await drop();
    },
  };
}

/** The queue driver of a shared target, as another process opens it (with the system clock). */
export function openDriver(target: SharedTarget, connections: Connections, options: { retryAfter?: number } = {}): { driver: QueueDriver; close(): Promise<void> } {
  const retryAfter = options.retryAfter ?? 90;
  if (target.kind === 'redis') {
    const redis = redisConnections(target.url, target.prefix);
    return { driver: new RedisQueueDriver(redis.get(), { retryAfter }), close: () => redis.close() };
  }
  return { driver: new DatabaseQueueDriver({ db: connections.get(), driver: target.kind }, { retryAfter }), close: async () => {} };
}

/** What a target's queue and cache settings are for an app process (the fixture app's environment). */
export function targetEnv(target: SharedTarget, retryAfter?: number): Record<string, string> {
  const retry = retryAfter === undefined ? {} : { [target.kind === 'redis' ? 'QUEUE_REDIS_RETRY_AFTER_SECONDS' : 'QUEUE_DATABASE_RETRY_AFTER_SECONDS']: String(retryAfter) };
  switch (target.kind) {
    case 'sqlite':
      return { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: target.file, QUEUE_DRIVER: 'database', CACHE_DRIVER: 'database', ...retry };
    case 'pgsql':
      return { DB_MANAGED: 'false', DB_DRIVER: 'pgsql', DB_URL: target.url, DB_POOL_MAX: '3', QUEUE_DRIVER: 'database', CACHE_DRIVER: 'database', ...retry };
    case 'redis':
      return { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: target.file, QUEUE_DRIVER: 'redis', CACHE_DRIVER: 'redis', REDIS_URL: target.url, REDIS_PREFIX: target.prefix, ...retry };
  }
}

const CLI = fileURLToPath(new URL('../../../cli/bin/marmeon.js', import.meta.url));
const APP = fileURLToPath(new URL('./app/', import.meta.url));

/** A `marmeon queue:work` process in the fixture app — the real command, with the real signal handling. */
export interface WorkerProcess {
  readonly child: ChildProcess;
  /** Every line it wrote so far (stdout and stderr). */
  readonly lines: string[];
  /** Waits for a line matching `pattern` (rejects after `ms`). */
  waitFor(pattern: RegExp, ms?: number): Promise<string>;
  /** Waits for the exit (rejects after `ms`): the exit code, or the signal's name. */
  exited(ms?: number): Promise<number | string>;
}

export function startWorker(target: SharedTarget, args: readonly string[], env: Record<string, string> = {}): WorkerProcess {
  return startProcess(['--conditions=@marmeon/source', CLI, 'queue:work', ...args], { ...targetEnv(target), ...env });
}

/** `marmeon fixture:dispatch` in the fixture app: says "ready", waits for "go" on stdin, then dispatches. */
export function startDispatcher(target: SharedTarget, args: readonly string[], env: Record<string, string> = {}): WorkerProcess {
  return startProcess(['--conditions=@marmeon/source', CLI, 'fixture:dispatch', ...args], { ...targetEnv(target), ...env }, 'pipe');
}

function startProcess(argv: readonly string[], env: Record<string, string>, stdin: 'ignore' | 'pipe' = 'ignore'): WorkerProcess {
  const child = spawn(process.execPath, argv, {
    cwd: APP,
    // Through the launcher, in this one process: the condition is set, so it neither re-executes nor needs MARMEON_CHILD.
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env },
    stdio: [stdin, 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  for (const stream of [child.stdout!, child.stderr!]) {
    createInterface({ input: stream }).on('line', (line) => {
      lines.push(line);
      if (process.env.MARMEON_TEST_VERBOSE) console.log(`[worker ${child.pid}] ${line}`);
      for (const waiter of waiters) waiter();
    });
  }
  const exit = once(child, 'exit').then(([code, signal]) => (code ?? signal) as number | string);
  return {
    child,
    lines,
    waitFor: (pattern, ms = 15_000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const line = lines.find((candidate) => pattern.test(candidate));
          if (line === undefined) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(line);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`No line matching ${pattern} within ${ms} ms. Output:\n${lines.join('\n')}`));
        }, ms);
        waiters.add(check);
        check();
      }),
    exited: (ms = 15_000) =>
      Promise.race([
        exit,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`The worker did not exit within ${ms} ms. Output:\n${lines.join('\n')}`)), ms).unref()),
      ]),
  };
}

/** Stops a worker that may still run (after a failed test). */
export function kill(worker: WorkerProcess | undefined): void {
  if (worker && worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
}

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { TestClock, type Clock, type Logger } from '@bespokecore/core';
import { Connections, Schema, sql, type ConnectionOptions } from '@bespokecore/database';
import { QUEUE_MIGRATION } from '../commands/failed.ts';
import type { FailedJobStore, QueueDriver } from '../driver.ts';
import { DatabaseFailedJobStore, DatabaseQueueDriver } from '../drivers/database.ts';
import { MemoryFailedJobStore, MemoryQueueDriver } from '../drivers/memory.ts';

/** Postgres runs when `BESPOKE_TEST_PGSQL_URL` is set (`pnpm test:pgsql`). */
export const PGSQL_URL = process.env.BESPOKE_TEST_PGSQL_URL;

export const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/** Where a queue keeps its jobs — enough for another process to open the same one. */
export type QueueTarget = { kind: 'memory' } | { kind: 'sqlite'; file: string } | { kind: 'pgsql'; url: string };
export type QueueKind = QueueTarget['kind'];

/** Every driver the suite runs against: memory and SQLite always, Postgres with its URL. */
export const queueKinds: readonly QueueKind[] = ['memory', 'sqlite', ...(PGSQL_URL ? (['pgsql'] as const) : [])];
/** The database drivers (what the worker processes and transactions need). */
export const databaseKinds: readonly Exclude<QueueKind, 'memory'>[] = ['sqlite', ...(PGSQL_URL ? (['pgsql'] as const) : [])];

export function databaseConnections(options: ConnectionOptions): Connections {
  return new Connections({ connections: { default: options }, root: '/', logger: silent });
}

export function connectionOptions(target: Exclude<QueueTarget, { kind: 'memory' }>, poolMax = 5): ConnectionOptions {
  return target.kind === 'sqlite' ? { driver: 'sqlite', database: target.file } : { driver: 'pgsql', url: target.url, poolMax };
}

/** Runs the queue migration (the file `make:queue-table` copies) and the fixture table `handled`. */
export async function migrate(connections: Connections): Promise<void> {
  const migration = ((await import(QUEUE_MIGRATION.href)) as { default: { up(schema: Schema): Promise<void> } }).default;
  const schema = new Schema(connections.get(), connections.options().driver);
  await migration.up(schema);
  await schema.create('handled', (table) => {
    table.string('uuid', 64);
    table.integer('n');
    table.integer('attempt');
    table.integer('pid');
    table.string('event');
  });
}

/** A fresh, empty, migrated target (a new SQLite file or Postgres database). */
export async function freshTarget(kind: QueueKind): Promise<{ target: QueueTarget; drop: () => Promise<void> }> {
  switch (kind) {
    case 'memory':
      return { target: { kind }, drop: async () => {} };
    case 'sqlite': {
      const directory = mkdtempSync(join(tmpdir(), 'bespoke-queue-'));
      const file = join(directory, 'queue.sqlite');
      const connections = databaseConnections({ driver: 'sqlite', database: file });
      await migrate(connections);
      await connections.destroy();
      return { target: { kind, file }, drop: async () => rmSync(directory, { recursive: true, force: true }) };
    }
    case 'pgsql': {
      const name = `bespoke_queue_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
  const connection = { db: connections.get(), driver: target.kind };
  return {
    driver: new DatabaseQueueDriver(connection, { retryAfter, clock: clock as Clock }),
    failed: new DatabaseFailedJobStore(connection),
    clock,
    target,
    connections,
    close: async () => {
      await connections.destroy();
      await drop();
    },
  };
}

const CLI = fileURLToPath(new URL('../../../cli/bin/bespoke.js', import.meta.url));
const APP = fileURLToPath(new URL('./app/', import.meta.url));

/** A `bespoke queue:work` process in the fixture app — the real command, with the real signal handling. */
export interface WorkerProcess {
  readonly child: ChildProcess;
  /** Every line it wrote so far (stdout and stderr). */
  readonly lines: string[];
  /** Waits for a line matching `pattern` (rejects after `ms`). */
  waitFor(pattern: RegExp, ms?: number): Promise<string>;
  /** Waits for the exit (rejects after `ms`): the exit code, or the signal's name. */
  exited(ms?: number): Promise<number | string>;
}

export function startWorker(target: Exclude<QueueTarget, { kind: 'memory' }>, args: readonly string[], env: Record<string, string> = {}): WorkerProcess {
  const database = target.kind === 'sqlite' ? { DB_CONNECTION: 'sqlite', DB_DATABASE: target.file } : { DB_CONNECTION: 'pgsql', DB_URL: target.url, DB_POOL_MAX: '3' };
  const child = spawn(process.execPath, ['--conditions=@bespokecore/source', CLI, 'queue:work', ...args], {
    cwd: APP,
    env: { PATH: process.env.PATH ?? '', BESPOKE_CHILD: '1', NODE_ENV: 'test', QUEUE_CONNECTION: 'database', ...database, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  for (const stream of [child.stdout!, child.stderr!]) {
    createInterface({ input: stream }).on('line', (line) => {
      lines.push(line);
      if (process.env.BESPOKE_TEST_VERBOSE) console.log(`[worker ${child.pid}] ${line}`);
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

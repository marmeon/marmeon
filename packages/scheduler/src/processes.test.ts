import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CACHE_MIGRATION } from '@marmeon/cache/internal';
import { Connections, sql, type ConnectionOptions, type Migration } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { RedisConnections } from '@marmeon/redis';
import { describe, expect, it } from 'vitest';
import { MINUTE } from './time.ts';

// The real `marmeon schedule:work` / `schedule:run` in the fixture app (`__fixtures__/app`), several at once — what a
// deployment with a scheduler on every server does. The fixture's clock reads FIXTURE_CLOCK_AT at its first read — the
// worker's loop, right after it logged that it runs — so a test places a minute boundary half a second later (LEAD)
// instead of waiting up to a minute. Two schedulers that must tick at one moment (the cross-process lock race) wait on a
// gate file at that first read, whatever their boot time, and start their clocks together when the test writes it.

const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL;
const CLI = fileURLToPath(new URL('../../cli/bin/marmeon.js', import.meta.url));
const APP = fileURLToPath(new URL('./__fixtures__/app/', import.meta.url));
const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/** Where the processes share their cache (the locks) — and the table `ran` they record their runs in. */
// `file`: the cache in files on this machine — locks hold for every process of one machine; the table `ran` in SQLite.
type Target = { kind: 'sqlite'; file: string } | { kind: 'file'; file: string; cache: string } | { kind: 'pgsql'; url: string } | { kind: 'redis'; file: string; url: string; prefix: string };
const kinds = ['sqlite', 'file', ...(PGSQL_URL ? (['pgsql'] as const) : []), ...(REDIS_URL ? (['redis'] as const) : [])] as const;

function connections(target: Target): Connections {
  const options: ConnectionOptions = target.kind === 'pgsql' ? { driver: 'pgsql', url: target.url, poolMax: 2 } : { driver: 'sqlite', database: target.file };
  return new Connections({ connections: { default: { ...options, managed: false } }, root: '/', logger: silent });
}

async function freshTarget(kind: Target['kind']): Promise<{ target: Target; drop: () => Promise<void> }> {
  let target: Target;
  let drop: () => Promise<void>;
  if (kind === 'pgsql') {
    const name = `marmeon_schedule_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL! } }, root: '/', logger: silent });
    await sql`create database ${sql.id(name)}`.execute(admin.get());
    const url = new URL(PGSQL_URL!);
    url.pathname = `/${name}`;
    target = { kind, url: url.href };
    drop = async () => {
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    };
  } else {
    const directory = mkdtempSync(join(tmpdir(), 'marmeon-schedule-'));
    const file = join(directory, 'app.sqlite');
    const removeFile = async () => rmSync(directory, { recursive: true, force: true });
    if (kind === 'sqlite') {
      target = { kind, file };
      drop = removeFile;
    } else if (kind === 'file') {
      target = { kind, file, cache: join(directory, 'cache') };
      drop = removeFile;
    } else {
      const prefix = `marmeon-schedule-test-${crypto.randomUUID().slice(0, 8)}:`;
      target = { kind, file, url: REDIS_URL!, prefix };
      drop = async () => {
        const redis = new RedisConnections({ connections: { default: { url: REDIS_URL!, prefix } }, logger: silent });
        const keys = await redis.get().command<string[]>(['KEYS', `${prefix}*`]);
        if (keys.length > 0) await redis.get().command(['DEL', ...keys]);
        await redis.close();
        await removeFile();
      };
    }
  }
  const db = connections(target);
  await runMigration(db, ((await import(CACHE_MIGRATION.href)) as { default: Migration }).default);
  await runMigration(db, {
    up: (schema) =>
      schema.create('ran', (table) => {
        table.string('task');
        table.bigInteger('minute');
        table.integer('pid');
      }),
  });
  await db.destroy();
  return { target, drop };
}

function env(target: Target): Record<string, string> {
  switch (target.kind) {
    case 'sqlite':
      return { DB_MANAGED: 'false', DB_CONNECTION: 'sqlite', DB_DATABASE: target.file, CACHE_DRIVER: 'database' };
    case 'file':
      return { DB_MANAGED: 'false', DB_CONNECTION: 'sqlite', DB_DATABASE: target.file, CACHE_DRIVER: 'file', CACHE_PATH: target.cache };
    case 'pgsql':
      return { DB_MANAGED: 'false', DB_CONNECTION: 'pgsql', DB_URL: target.url, DB_POOL_MAX: '2', CACHE_DRIVER: 'database' };
    case 'redis':
      return { DB_MANAGED: 'false', DB_CONNECTION: 'sqlite', DB_DATABASE: target.file, CACHE_DRIVER: 'redis', REDIS_URL: target.url, REDIS_PREFIX: target.prefix };
  }
}

async function ran(target: Target): Promise<{ task: string; minute: number; pid: number }[]> {
  const db = connections(target);
  try {
    const { rows } = await sql<{ task: string; minute: number | string; pid: number }>`select task, minute, pid from ran order by minute, task`.execute(db.get());
    return rows.map((row) => ({ ...row, minute: Number(row.minute) }));
  } finally {
    await db.destroy();
  }
}

interface SchedulerProcess {
  readonly child: ChildProcess;
  readonly lines: string[];
  waitFor(pattern: RegExp, ms?: number): Promise<void>;
  exited(): Promise<number | string>;
}

/** Stops what a test started and is still running (after a failure). */
function kill(processes: readonly SchedulerProcess[]): void {
  for (const process of processes) if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL');
}

function start(started: SchedulerProcess[], command: 'schedule:work' | 'schedule:run', processEnv: Record<string, string>): SchedulerProcess {
  const child = spawn(process.execPath, ['--conditions=@marmeon/source', CLI, command], {
    cwd: APP,
    // Through the launcher, in this one process: the condition is set, so it neither re-executes nor needs MARMEON_CHILD.
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', LOG_LEVEL: 'info', ...processEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  for (const stream of [child.stdout!, child.stderr!]) {
    createInterface({ input: stream }).on('line', (line) => {
      lines.push(line);
      if (process.env.MARMEON_TEST_VERBOSE) console.log(`[${command} ${child.pid}] ${line}`);
      for (const waiter of waiters) waiter();
    });
  }
  const exit = once(child, 'exit').then(([code, signal]) => (code ?? signal) as number | string);
  const handle: SchedulerProcess = {
    child,
    lines,
    waitFor: (pattern, ms = 20_000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (!lines.some((line) => pattern.test(line))) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`No line matching ${pattern} within ${ms} ms. Output:\n${lines.join('\n')}`));
        }, ms);
        waiters.add(check);
        check();
      }),
    exited: () => exit,
  };
  started.push(handle);
  return handle;
}

/** How long before the boundary the fixture's clock reads `FIXTURE_CLOCK_AT`. */
const LEAD = 500;
/**
 * The fixture clock (`FIXTURE_CLOCK_AT`) that puts the minute boundary `minute` — by default the next one — `LEAD` ms
 * after the first read (after the release of the gate, for gated processes).
 */
function boundary(minute = Math.ceil(Date.now() / MINUTE) * MINUTE): { clock: Record<string, string>; minute: number } {
  return { clock: { FIXTURE_CLOCK_AT: String(minute - LEAD) }, minute };
}

/** A gate for processes that must start their clocks together: they block at their first clock read until `release()`. */
function gate(): { env: Record<string, string>; release(): void; remove(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'marmeon-schedule-gate-'));
  const file = join(directory, 'real');
  return {
    env: { FIXTURE_CLOCK_GATE: file },
    // The real instant at which the clocks read FIXTURE_CLOCK_AT: shortly ahead, so that every process woken by the file
    // has read its clock before the boundary. Renamed into place, so a process never sees half a number.
    release() {
      writeFileSync(`${file}.tmp`, String(Date.now() + 300));
      renameSync(`${file}.tmp`, file);
    },
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function stop(...processes: SchedulerProcess[]): Promise<void> {
  for (const process of processes) process.child.kill('SIGTERM');
  for (const process of processes) expect(await process.exited()).toBe(0);
}

// Concurrent: each test sets the clocks of its own processes.
describe.concurrent.each(kinds)('schedule:work on %s', (kind) => {
  it('two schedulers, a task onOneServer(): it runs once in the minute — not once per scheduler', { timeout: 60_000 }, async () => {
    const { target, drop } = await freshTarget(kind);
    const started: SchedulerProcess[] = [];
    const gated = gate();
    try {
      const { clock, minute } = boundary();
      const shared = { ...env(target), FIXTURE_ONE_SERVER: '1', LOG_LEVEL: 'debug', ...clock, ...gated.env };
      const one = start(started, 'schedule:work', shared);
      const two = start(started, 'schedule:work', shared);
      await Promise.all([one.waitFor(/Running the schedule every minute/), two.waitFor(/Running the schedule every minute/)]);
      gated.release();
      // Both ticked the boundary (each logs the run it started or the lock it found taken).
      await Promise.all([one.waitFor(/Running record|Skipped record: another server runs it/), two.waitFor(/Running record|Skipped record: another server runs it/)]);
      await stop(one, two);
      expect(await ran(target)).toEqual([{ task: 'record', minute, pid: expect.any(Number) }]);
    } finally {
      gated.remove();
      kill(started);
      await drop();
    }
  });
});

describe.concurrent('the scheduler processes (sqlite)', () => {
  it('without onOneServer() each scheduler runs the task — the control of the test above', { timeout: 60_000 }, async () => {
    const { target, drop } = await freshTarget('sqlite');
    const started: SchedulerProcess[] = [];
    const gated = gate();
    try {
      const { clock, minute } = boundary();
      const shared = { ...env(target), ...clock, ...gated.env };
      const one = start(started, 'schedule:work', shared);
      const two = start(started, 'schedule:work', shared);
      await Promise.all([one.waitFor(/Running the schedule every minute/), two.waitFor(/Running the schedule every minute/)]);
      gated.release();
      await Promise.all([one.waitFor(/Running record/), two.waitFor(/Running record/)]);
      await stop(one, two);
      const rows = await ran(target);
      expect(rows.map((row) => [row.task, row.minute])).toEqual([
        ['record', minute],
        ['record', minute],
      ]);
      expect(new Set(rows.map((row) => row.pid)).size).toBe(2);
    } finally {
      gated.remove();
      kill(started);
      await drop();
    }
  });

  it('a scheduler down for ten minutes catches up once when it starts again', { timeout: 60_000 }, async () => {
    const { target, drop } = await freshTarget('sqlite');
    const started: SchedulerProcess[] = [];
    try {
      // The first scheduler ticks one minute, then stops.
      const first = boundary();
      const before = start(started, 'schedule:work', { ...env(target), ...first.clock, FIXTURE_MISSED: String(new Date(first.minute + 5 * MINUTE).getUTCMinutes()) });
      await before.waitFor(/Running record/);
      await stop(before);
      // Ten minutes later (by the app's clock) it starts again: its next tick is eleven minutes after the last one.
      const back = boundary(first.minute + 11 * MINUTE);
      const after = start(started, 'schedule:work', { ...env(target), ...back.clock, FIXTURE_MISSED: String(new Date(first.minute + 5 * MINUTE).getUTCMinutes()) });
      await Promise.all([after.waitFor(/Running missed — missed while/), after.waitFor(/Running record/)]);
      await stop(after);
      expect((await ran(target)).map((row) => [row.task, row.minute])).toEqual([
        ['record', first.minute],
        ['missed', back.minute],
        ['record', back.minute],
      ]);
      expect(after.lines.some((line) => line.includes('Running missed — missed while the scheduler was down'))).toBe(true);
    } finally {
      kill(started);
      await drop();
    }
  });

  it('schedule:run, from cron on two servers at once: once, and the runs in its output', { timeout: 30_000 }, async () => {
    const { target, drop } = await freshTarget('sqlite');
    const started: SchedulerProcess[] = [];
    try {
      // Not across a minute boundary: both runs start in the middle of a minute of the app's clock and tick that one.
      const shared = { ...env(target), FIXTURE_ONE_SERVER: '1', FIXTURE_CLOCK_AT: String(boundary().minute + MINUTE / 2) };
      const one = start(started, 'schedule:run', shared);
      const two = start(started, 'schedule:run', shared);
      expect([await one.exited(), await two.exited()]).toEqual([0, 0]);
      expect((await ran(target)).map((row) => row.task)).toEqual(['record']);
      const outputs = [...one.lines, ...two.lines].filter((line) => line.startsWith('record:'));
      expect(outputs.filter((line) => /^record: ran \(\d+ ms\)$/.test(line))).toHaveLength(1);
      expect(outputs.filter((line) => line === 'record: skipped — another server runs it')).toHaveLength(1);
    } finally {
      kill(started);
      await drop();
    }
  });

  // A cache that is not shared is no reason to refuse — a single scheduler runs correctly with it, in
  // production too. The start says where the locks hold.
  it.each([
    ['file', 'onOneServer() locks in CACHE_DRIVER=file: locks only hold on this machine. With more than one scheduler instance (more servers), use CACHE_DRIVER=database (marmeon make:cache-table) or redis. Tasks: record'],
    ['memory', 'onOneServer() locks in CACHE_DRIVER=memory: locks only hold in this process — a second schedule:work, even on this machine, runs the tasks again.'],
  ])('starts with onOneServer() on a %s cache, in production too — and warns', { timeout: 30_000 }, async (driver, warning) => {
    const directory = mkdtempSync(join(tmpdir(), 'marmeon-schedule-file-'));
    const started: SchedulerProcess[] = [];
    try {
      // Production without a .env: everything it needs is given here.
      const work = start(started, 'schedule:work', { NODE_ENV: 'production', DB_MANAGED: 'false', DB_DATABASE: ':memory:', CACHE_DRIVER: driver, CACHE_PATH: directory, FIXTURE_ONE_SERVER: '1' });
      await work.waitFor(/Running the schedule every minute/);
      expect(work.lines.join('\n')).toContain(warning);
      await stop(work);
    } finally {
      kill(started);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliServiceProvider, CommandRegistry, DevProcesses } from 'marmeon';
import { Clock, createApplication, Logger, resolveConfig, TestClock, type Application, type Resolver } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, type Migration } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { migrate, silent } from '../__fixtures__/targets.ts';
import { QueueConnections } from '../connections.ts';
import { Queue, QUEUE_MIGRATION, QueueConfig, QueueServiceProvider } from '../index.ts';
import { MakeQueueTableCommand, QueueFailedCommand, QueueFlushCommand, QueueForgetCommand, QueuePruneFailedCommand, QueueRetryCommand, QueueSizeCommand } from './failed.ts';
import { QueueWorkCommand } from './work.ts';
import { tempDir } from '../../../../scripts/test/temp-dir.js';

class PingJob {
  static readonly job = 'test.ping';
  static readonly schema = v.object({ n: v.number() });
  handle() {}
}

class SecretJob {
  static readonly job = 'test.secret';
  static readonly schema = v.object({ token: v.string() });
  static readonly encrypted = true;
  handle() {}
}

async function app(options: { env?: Record<string, string>; providers?: 'all' | 'no-database' | 'no-encryption'; jobs?: unknown[] } = {}): Promise<Application & { clock: TestClock }> {
  const clock = new TestClock();
  const providers =
    options.providers === 'no-database'
      ? [CliServiceProvider, QueueServiceProvider]
      : options.providers === 'no-encryption'
        ? [CliServiceProvider, DatabaseServiceProvider, QueueServiceProvider]
        : [CliServiceProvider, DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider];
  const application = await createApplication({
    root: '/tmp',
    discover: false,
    env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=', ...options.env },
    providers,
    modules: [{ name: 'test', jobs: (options.jobs ?? [PingJob]) as never }],
    override: (container) => {
      container.instance(Clock, clock);
      container.instance(Logger, silent);
    },
  });
  if (application.container.has(Connections)) await migrate(application.container.make(Connections));
  return Object.assign(application, { clock });
}

function input(root: string, args: string[] = [], options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
  return { input: { root, args, options, output, spawn: async () => 0 } as never, lines };
}

describe('the queue provider', () => {
  it('adds the queue commands and a worker for `marmeon dev` (E101) — none with the sync connection', async () => {
    await using application = await app();
    const commands = application.container.make(CommandRegistry).all().map((command) => command.command);
    expect(commands).toEqual(
      expect.arrayContaining(['queue:work', 'queue:failed', 'queue:retry', 'queue:forget', 'queue:flush', 'queue:prune-failed', 'queue:size', 'make:queue-table']),
    );
    expect(application.container.make(DevProcesses).all()).toEqual([{ name: 'queue', args: ['queue:work', '--stop-timeout=5'] }]);

    await using sync = await app({ env: { QUEUE_CONNECTION: 'sync' } });
    expect(sync.container.make(DevProcesses).all()).toEqual([]);
  });

  it('fails the start with what is missing: the database package for QUEUE_CONNECTION=database, the Encrypter for encrypted jobs', async () => {
    await expect(app({ providers: 'no-database' })).rejects.toThrow(
      'The database queue needs the DatabaseServiceProvider of @marmeon/database (installed packages register it: marmeon discover).',
    );
    await using sync = await app({ providers: 'no-database', env: { QUEUE_CONNECTION: 'sync', QUEUE_FAILED_DRIVER: 'null' } });
    expect(sync.container.make(Queue)).toBeDefined();
    await expect(app({ providers: 'no-encryption', jobs: [SecretJob] })).rejects.toThrow('An encrypted job (static encrypted) needs the EncryptionServiceProvider');
    await expect(app({ env: { DB_QUEUE_CONNECTION: 'reporting' } })).rejects.toThrow(/Database connection "reporting" is not configured/);
    await expect(app({ env: { QUEUE_CONNECTION: 'redis' } })).rejects.toThrow(
      'QUEUE_CONNECTION=redis needs the RedisServiceProvider of @marmeon/redis (installed packages register it: marmeon discover).',
    );
  });
});

describe('the queue commands', () => {
  it('queue:work refuses to start with a timeout retryAfter cannot cover — a message, not a stack trace', async () => {
    await using application = await app({ env: { DB_QUEUE_RETRY_AFTER: '30' } });
    const { input: run, lines } = input('/tmp');
    expect(await application.container.make(QueueWorkCommand).handle(run)).toBe(1);
    expect(lines).toEqual([expect.stringMatching(/^✗ The queue connection "database" gives a claimed job 30s \(retryAfter\).*test\.ping \(timeout 60s\)/)]);
  });

  it('queue:work without --queue (or with --queue=*) takes every queue, oldest first; --queue only narrows it down (E199)', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    const connections = application.container.make(QueueConnections);
    const work = async (options: Record<string, unknown>) => {
      const { input: run, lines } = input('/tmp', [], { 'stop-when-empty': true, ...options });
      const code = await application.container.make(QueueWorkCommand).handle(run);
      return { code, line: lines[0] };
    };
    const line = (queues: string) => new RegExp(`^Processing jobs of the database connection: ${queues.replaceAll('(', '\\(').replaceAll(')', '\\)')} — in `);

    // --queue narrows it down: only mail runs, the default queue's job waits.
    await queue.dispatch(PingJob, { n: 1 });
    await queue.dispatch(PingJob, { n: 2 }, { queue: 'mail' });
    const narrowed = await work({ queue: 'mail' });
    expect([await connections.driver('database').size('mail'), await connections.driver('database').size('default')], 'only the named queue ran').toEqual([0, 1]);
    expect(narrowed.line).toMatch(line('mail'));

    // Without --queue every queue: the default queue's job runs too.
    await queue.dispatch(PingJob, { n: 3 }, { queue: 'reports' });
    const every = await work({});
    expect([await connections.driver('database').size('default'), await connections.driver('database').size('reports')], 'a worker without --queue left jobs').toEqual([0, 0]);
    expect(every.line).toMatch(line('every queue (oldest first)'));
    expect((await work({ queue: '*' })).line).toMatch(line('every queue (oldest first)'));
    expect((await work({ queue: 'mail,*' })).line).toMatch(line('mail, every other queue (oldest first)'));

    // A --queue that names nothing, or * twice, is a message.
    for (const [value, message] of [
      ['', '✗ --queue names no queue — leave it out to take every queue.'],
      [' , ', '✗ --queue names no queue — leave it out to take every queue.'],
      ['*,mail,*', '✗ --queue names * more than once.'],
    ] as const) {
      const { input: run, lines } = input('/tmp', [], { queue: value, 'stop-when-empty': true });
      expect(await application.container.make(QueueWorkCommand).handle(run)).toBe(1);
      expect(lines).toEqual([message]);
    }
  });

  it('lists, retries (same id, attempts from zero), forgets, flushes and prunes failed jobs; counts queues', async () => {
    await using application = await app();
    application.clock.freeze(Date.UTC(2026, 9, 2, 12));
    const connections = application.container.make(QueueConnections);
    const failed = connections.failed();
    const payload = (uuid: string) => JSON.stringify({ uuid, job: 'test.ping', data: { n: 1 }, tries: 1, backoff: [], dispatchedAt: 0 });
    await failed.record({ uuid: 'old', connection: 'database', queue: 'default', job: 'test.ping', payload: payload('old'), exception: 'Error: old\n    at x', failedAt: application.clock.now() - 200 * 3_600_000 });
    await failed.record({ uuid: 'new', connection: 'database', queue: 'mail', job: 'test.ping', payload: payload('new'), exception: 'Error: new', failedAt: application.clock.now() });

    const listed = input('/tmp');
    await application.container.make(QueueFailedCommand).handle(listed.input);
    expect(listed.lines).toEqual([
      '2026-10-02T12:00:00.000Z  new  test.ping  (database/mail)',
      '    Error: new',
      '2026-09-24T04:00:00.000Z  old  test.ping  (database/default)',
      '    Error: old',
      '2 failed jobs — marmeon queue:retry <id|all>, queue:forget <id>',
    ]);

    const pruned = input('/tmp', [], { hours: '168' });
    await application.container.make(QueuePruneFailedCommand).handle(pruned.input);
    expect(pruned.lines).toEqual(['✓ Pruned 1 failed job older than 168 hours.']);

    const retried = input('/tmp', ['new', 'missing']);
    expect(await application.container.make(QueueRetryCommand).handle(retried.input)).toBe(1);
    expect(retried.lines).toEqual(['✓ Queued test.ping (new) again on database/mail', '✗ No failed job with the id missing.']);
    const job = await connections.driver('database').reserve(['mail']);
    expect(job).toMatchObject({ attempts: 1 });
    expect(JSON.parse(job!.payload)).toMatchObject({ uuid: 'new' });

    const sized = input('/tmp', ['mail', 'default']);
    await application.container.make(QueueSizeCommand).handle(sized.input);
    expect(sized.lines).toEqual(['database/mail: 1', 'database/default: 0']);
    // Without names: every queue that holds jobs, the default one first (also when empty).
    await application.container.make(Queue).dispatch(PingJob, { n: 2 }, { queue: 'reports' });
    const all = input('/tmp');
    await application.container.make(QueueSizeCommand).handle(all.input);
    expect(all.lines).toEqual(['database/default: 0', 'database/mail: 1', 'database/reports: 1']);

    await failed.record({ uuid: 'x', connection: 'database', queue: 'default', job: 'test.ping', payload: payload('x'), exception: 'Error: x', failedAt: 0 });
    const forgot = input('/tmp', ['x']);
    expect(await application.container.make(QueueForgetCommand).handle(forgot.input)).toBe(0);
    expect(await application.container.make(QueueForgetCommand).handle(input('/tmp', ['x']).input)).toBe(1);
    await failed.record({ uuid: 'y', connection: 'database', queue: 'default', job: 'test.ping', payload: payload('y'), exception: 'Error: y', failedAt: 0 });
    const flushed = input('/tmp');
    await application.container.make(QueueFlushCommand).handle(flushed.input);
    expect(flushed.lines).toEqual(['✓ Deleted 1 failed job.']);
  });

  it("the apps' and the starter's jobs tables are the stub's: made with the fair claim's index, no migration adds it later (E199, E216)", () => {
    const stub = readFileSync(new URL('../../stubs/migrations/create_jobs_table.ts', import.meta.url), 'utf8');
    const index = "      // A worker without --queue claims the oldest due job of every queue in one statement — this index serves it.\n      table.index(['reserved_at', 'available_at', 'id']);\n";
    expect(stub, 'make:queue-table writes a new table with the index').toContain(index);
    const repo = new URL('../../../../', import.meta.url);
    // No release came before the index: the table is made with it, the way make:queue-table writes it.
    for (const [dir, created] of [
      ['apps/web-app/modules/system/migrations/', '2026_10_02_211222_create_jobs_table.ts'],
      ['apps/blank-app/modules/system/migrations/', '2026_10_03_002234_create_jobs_table.ts'],
      ['packages/create-marmeon/template/base/modules/system/migrations/', '2026_10_03_002234_create_jobs_table.ts'],
    ] as const) {
      expect(readFileSync(new URL(dir + created, repo), 'utf8'), dir).toBe(stub);
      expect(readdirSync(new URL(dir, repo)).filter((file) => /jobs_table/.test(file)), dir).toEqual([created]);
    }
  });

  it("make:queue-table's migration runs on DB_QUEUE_CONNECTION — a failed_jobs connection of its own stops it with what to do", async () => {
    const { default: migration } = (await import(QUEUE_MIGRATION.href)) as { default: Migration };
    const on = async (env: Record<string, string>) => {
      const config = (await resolveConfig([QueueConfig], env)).get(QueueConfig);
      const container = { make: () => config } as unknown as Resolver;
      return typeof migration.connection === 'function' ? migration.connection(container) : (migration.connection ?? 'default');
    };
    expect(await on({ DB_QUEUE_CONNECTION: 'queue' })).toBe('queue');
    expect(await on({})).toBe('default');
    expect(await on({ DB_QUEUE_CONNECTION: 'queue', QUEUE_FAILED_CONNECTION: 'queue' })).toBe('queue');
    // Failed jobs only logged: their table is never used, wherever QUEUE_FAILED_CONNECTION points.
    expect(await on({ DB_QUEUE_CONNECTION: 'queue', QUEUE_FAILED_DRIVER: 'null', QUEUE_FAILED_CONNECTION: 'archive' })).toBe('queue');
    await expect(on({ QUEUE_FAILED_CONNECTION: 'archive' })).rejects.toThrow(
      'The migration of make:queue-table creates jobs and failed_jobs on one connection, DB_QUEUE_CONNECTION (default) — but QUEUE_FAILED_CONNECTION is archive. Move the failed_jobs part into a migration of its own with connection: \'archive\', or let both use one connection.',
    );
  });

  it('make:queue-table writes the migration of jobs and failed_jobs into the system module (E96)', async () => {
    const root = tempDir('marmeon-queue-table-');
    mkdirSync(join(root, 'bootstrap'));
    writeFileSync(join(root, 'bootstrap/app.ts'), "import { defineApplication } from '@marmeon/core';\n\nexport default defineApplication({ root: '', modules: [] });\n");
    const { input: run, lines } = input(root);
    expect(await new MakeQueueTableCommand().handle(run)).toBe(0);
    const [migration] = readdirSync(join(root, 'modules/system/migrations'));
    expect(migration).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}_create_jobs_table\.ts$/);
    const contents = readFileSync(join(root, 'modules/system/migrations', migration!), 'utf8');
    expect(contents).toContain("schema.create('jobs'");
    expect(contents).toContain("schema.create('failed_jobs'");
    // The index of the fair claim (E199): a worker without --queue takes the oldest due job of every queue through it.
    expect(contents).toContain("table.index(['reserved_at', 'available_at', 'id']);");
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8')).toContain('modules: [system]');
    expect(lines.at(-1)).toBe('Then: marmeon migrate');
  });
});

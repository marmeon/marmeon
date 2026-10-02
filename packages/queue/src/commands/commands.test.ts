import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliServiceProvider, CommandRegistry, DevProcesses } from '@bespokecore/cli';
import { Clock, createApplication, Logger, TestClock, type Application } from '@bespokecore/core';
import { Connections, DatabaseServiceProvider } from '@bespokecore/database';
import { EncryptionServiceProvider } from '@bespokecore/encryption';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, silent } from '../__fixtures__/targets.ts';
import { QueueConnections } from '../connections.ts';
import { Queue, QueueServiceProvider } from '../index.ts';
import { MakeQueueTableCommand, QueueFailedCommand, QueueFlushCommand, QueueForgetCommand, QueuePruneFailedCommand, QueueRetryCommand, QueueSizeCommand } from './failed.ts';
import { QueueWorkCommand } from './work.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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
  it('adds the queue commands and a worker for `bespoke dev` (E101) — none with the sync connection', async () => {
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
      'The database queue needs the DatabaseServiceProvider of @bespokecore/database (installed packages register it: bespoke discover).',
    );
    await using sync = await app({ providers: 'no-database', env: { QUEUE_CONNECTION: 'sync', QUEUE_FAILED_DRIVER: 'null' } });
    expect(sync.container.make(Queue)).toBeDefined();
    await expect(app({ providers: 'no-encryption', jobs: [SecretJob] })).rejects.toThrow('An encrypted job (static encrypted) needs the EncryptionServiceProvider');
    await expect(app({ env: { DB_QUEUE_CONNECTION: 'reporting' } })).rejects.toThrow(/Database connection "reporting" is not configured/);
  });
});

describe('the queue commands', () => {
  it('queue:work refuses to start with a timeout retryAfter cannot cover — a message, not a stack trace', async () => {
    await using application = await app({ env: { DB_QUEUE_RETRY_AFTER: '30' } });
    const { input: run, lines } = input('/tmp');
    expect(await application.container.make(QueueWorkCommand).handle(run)).toBe(1);
    expect(lines).toEqual([expect.stringMatching(/^✗ The queue connection "database" gives a claimed job 30s \(retryAfter\).*test\.ping \(timeout 60s\)/)]);
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
      '2 failed jobs — bespoke queue:retry <id|all>, queue:forget <id>',
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

    await failed.record({ uuid: 'x', connection: 'database', queue: 'default', job: 'test.ping', payload: payload('x'), exception: 'Error: x', failedAt: 0 });
    const forgot = input('/tmp', ['x']);
    expect(await application.container.make(QueueForgetCommand).handle(forgot.input)).toBe(0);
    expect(await application.container.make(QueueForgetCommand).handle(input('/tmp', ['x']).input)).toBe(1);
    await failed.record({ uuid: 'y', connection: 'database', queue: 'default', job: 'test.ping', payload: payload('y'), exception: 'Error: y', failedAt: 0 });
    const flushed = input('/tmp');
    await application.container.make(QueueFlushCommand).handle(flushed.input);
    expect(flushed.lines).toEqual(['✓ Deleted 1 failed job.']);
  });

  it('make:queue-table writes the migration of jobs and failed_jobs into the system module (E96)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bespoke-queue-table-'));
    temporary.push(root);
    mkdirSync(join(root, 'bootstrap'));
    writeFileSync(join(root, 'bootstrap/app.ts'), "import { defineApplication } from '@bespokecore/core';\n\nexport default defineApplication({ root: '', modules: [] });\n");
    const { input: run, lines } = input(root);
    expect(await new MakeQueueTableCommand().handle(run)).toBe(0);
    const [migration] = readdirSync(join(root, 'modules/system/migrations'));
    expect(migration).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}_create_jobs_table\.ts$/);
    const contents = readFileSync(join(root, 'modules/system/migrations', migration!), 'utf8');
    expect(contents).toContain("schema.create('jobs'");
    expect(contents).toContain("schema.create('failed_jobs'");
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8')).toContain('modules: [system]');
    expect(lines.at(-1)).toBe('Then: bespoke migrate');
  });
});

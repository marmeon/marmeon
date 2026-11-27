import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKey } from '@marmeon/encryption';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { repo } from '../__fixtures__/cli.ts';
import type { CommandClass } from '../command.ts';
import type { JsonRun } from '../spawn.ts';

// The doctor path runs `marmeon migrate:status` as a child; the stand-in answers in its place.
const stand = vi.hoisted(() => ({ run: undefined as unknown as () => Promise<unknown> }));
// Partial: the app this check loads imports other exports of spawn.ts, and only the child run is stubbed.
vi.mock('../spawn.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../spawn.ts')>()), runMarmeonJson: () => stand.run() }));

const { migrationsCheck } = await import('./migrations.ts');

const blank = join(repo, 'apps/blank-app');
const entry = createRequire(join(blank, 'package.json')).resolve('@marmeon/database');
const provider = ((await import(pathToFileURL(entry).href)) as { DatabaseServiceProvider: { commands: readonly CommandClass[] } }).DatabaseServiceProvider;
const command = provider.commands.find((candidate) => candidate.command === 'migrate:status')!;
const status = { registry: true, command } as const;

const answer = (over: Partial<JsonRun>): JsonRun => ({ code: 0, document: undefined, stderrTail: '', timedOut: false, tooLarge: false, ...over });
const check = async () => (await migrationsCheck(blank, { status })).report;

describe('migrationsCheck on the answer of migrate:status', () => {
  // The check boots the app once itself, to read its registry as the child will find it.
  beforeAll(() => {
    vi.stubEnv('APP_KEY', generateKey());
    vi.stubEnv('APP_NAME', 'Mark');
    vi.stubEnv('APP_URL', 'https://example.test');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DB_DATABASE', ':memory:');
    return () => void vi.unstubAllEnvs();
  });

  it.each([
    ['a document of format 2', answer({ document: { format: 2, migrations: [], warnings: [] } }), 'does not read'],
    ['an entry without a status', answer({ document: { format: 1, migrations: [{ name: 'a', module: 'm' }], warnings: [] } }), 'does not read'],
    ['output that is no JSON document', answer({ document: undefined }), 'did not print one JSON document'],
    ['more output than the cap', answer({ tooLarge: true }), 'more than 16 MiB'],
    ['a run that ran out of time', answer({ timedOut: true, code: 1 }), 'did not answer in time: migrate:status was stopped after 60 seconds'],
    ['a run that failed', answer({ code: 1, stderrTail: 'boom' }), 'marmeon migrate:status failed: boom'],
  ])('is an error, never failed, for %s', async (_name, result, reason) => {
    stand.run = () => Promise.resolve(result);
    const report = await check();
    expect(report).toMatchObject({ status: 'error', problems: [], reason: expect.stringContaining(reason) });
  });

  it('is an error that says the command could not be started when the runner rejects, with the reason masked', async () => {
    stand.run = () => Promise.reject(new Error('spawn failed for DB_PASSWORD=hunter2-unlikely'));
    const report = await check();
    expect(report).toMatchObject({ status: 'error', problems: [], reason: expect.stringMatching(/^marmeon migrate:status could not be started: spawn failed/) });
    expect(report.reason).not.toContain('hunter2-unlikely');
  });

  it('names each migration that has not run, and keeps a warning a warning', async () => {
    stand.run = () => Promise.resolve(answer({ document: { format: 1, migrations: [{ name: 'a', module: 'm', status: 'pending' }, { name: 'b', module: 'm', batch: 1, status: 'ran' }], warnings: ['b changed'] } }));
    const report = await check();
    expect(report.status).toBe('failed');
    expect(report.problems).toMatchObject([{ severity: 'error', message: 'a (module m) has not run', fix: 'marmeon migrate' }, { severity: 'warning', message: 'b changed' }]);
  });
  it('reports a migration that stopped halfway as an error with the way out, from the structured key and not from a warning', async () => {
    const interrupted = { name: 'a', module: 'm', direction: 'down', startedAt: '2026-11-27T10:00:00.000Z' };
    stand.run = () => Promise.resolve(answer({ document: { format: 1, migrations: [{ name: 'b', module: 'm', batch: 1, status: 'ran' }], warnings: [], interrupted } }));
    const report = await check();
    expect(report.status).toBe('failed');
    expect(report.problems).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: 'a (module m) started its down() at 2026-11-27T10:00:00.000Z and has not finished (it may be running now); once it is not, run marmeon migrate --interrupted=retry after undoing it, or marmeon migrate --interrupted=done after finishing it',
        docs: 'docs/migrations.md#a-migration-that-stopped-halfway',
      }),
    ]);
    expect(report.problems[0]).not.toHaveProperty('fix');
    // An up() is also pending: its entry gives way to the interruption, and another pending migration stays.
    const up = { ...interrupted, direction: 'up' };
    stand.run = () => Promise.resolve(answer({ document: { format: 1, migrations: [{ name: 'a', module: 'm', status: 'pending' }, { name: 'c', module: 'm', status: 'pending' }], warnings: [], interrupted: up } }));
    expect((await check()).problems).toMatchObject([{ severity: 'error', message: expect.stringContaining('a (module m) started its up()') }, { severity: 'error', message: 'c (module m) has not run', fix: 'marmeon migrate' }]);
    stand.run = () => Promise.resolve(answer({ document: { format: 1, migrations: [], warnings: [], interrupted: null } }));
    expect((await check()).problems).toEqual([]);
    stand.run = () => Promise.resolve(answer({ document: { format: 1, migrations: [], warnings: [], interrupted: { name: 'a' } } }));
    expect(await check()).toMatchObject({ status: 'error', reason: expect.stringContaining('does not read') });
  });
});

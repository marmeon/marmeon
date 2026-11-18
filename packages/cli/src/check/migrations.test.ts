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
vi.mock('../spawn.ts', () => ({ runMarmeonJson: () => stand.run() }));

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
});

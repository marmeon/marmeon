import { rmSync } from 'node:fs';
import { createApplication, Logger } from '@marmeon/core';
import { runWithRequest } from '@marmeon/core/internal';
import { DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { connectionsAt, migrate, sqliteTarget } from './__fixtures__/database.ts';
import { LiveHub } from './hub.ts';
import { Broadcaster, LiveServiceProvider } from './index.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Boots an app like a queue worker or the scheduler does — it serves no streams — and sends two hints; returns what it warned. */
async function warningsOf(env: Record<string, string>, { serving = false, inRequest = false, outside = true } = {}): Promise<string[]> {
  const directory = tempDir('marmeon-live-warning');
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const target = sqliteTarget(directory);
  const setup = connectionsAt(target);
  await migrate(setup);
  await setup.destroy();
  const warnings: string[] = [];
  const logging: Logger = { debug() {}, info() {}, warn: (message) => void warnings.push(message), error() {}, child: () => logging };
  const app = await createApplication(
    { root: directory, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider, LiveServiceProvider] },
    { env: { APP_KEY: generateKey(), DB_DRIVER: 'sqlite', DB_DATABASE: target.driver === 'sqlite' ? target.file : '', DB_MANAGED: 'false', ...env }, override: (container) => container.instance(Logger, logging) },
  );
  cleanups.push(() => app.shutdown());
  if (serving) await app.container.make(LiveHub).listen();
  if (inRequest) await runWithRequest({ requestId: 'req-1' }, () => app.container.make(Broadcaster).refresh('orders.6'));
  if (outside) {
    await app.container.make(Broadcaster).refresh('orders.7');
    await app.container.make(Broadcaster).refresh('orders.8');
  }
  return warnings;
}

describe('a process that serves no streams, sending hints', () => {
  it('warns once with LIVE_DRIVER=memory in production — the hints reach no web process', async () => {
    const warnings = await warningsOf({ NODE_ENV: 'production', LIVE_DRIVER: 'memory' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('LIVE_DRIVER=database');
    expect(warnings[0]).toContain('docs/realtime.md#more-than-one-process');
  });

  it('does not warn with LIVE_DRIVER=database', async () => {
    expect(await warningsOf({ NODE_ENV: 'production', LIVE_DRIVER: 'database' })).toEqual([]);
  });

  it.each(['development', 'test'])('does not warn in %s, where hints stay in the process by design', async (NODE_ENV) => {
    expect(await warningsOf({ NODE_ENV, LIVE_DRIVER: 'memory' })).toEqual([]);
  });

  it('does not warn for a hint sent inside a request — a server whose hub listens once the first stream opens', async () => {
    expect(await warningsOf({ NODE_ENV: 'production', LIVE_DRIVER: 'memory' }, { inRequest: true, outside: false })).toEqual([]);
  });

  it('still warns once for a hint outside a request, after one inside', async () => {
    expect(await warningsOf({ NODE_ENV: 'production', LIVE_DRIVER: 'memory' }, { inRequest: true })).toHaveLength(1);
  });

  it('does not warn in a process that serves streams', async () => {
    expect(await warningsOf({ NODE_ENV: 'production', LIVE_DRIVER: 'memory' }, { serving: true })).toEqual([]);
  });
});

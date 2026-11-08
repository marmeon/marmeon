import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication, Logger } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { connectionsAt, migrate, silent, sqliteTarget } from './__fixtures__/database.ts';
import { LiveHub } from './hub.ts';
import { LiveServiceProvider } from './index.ts';
import { LiveStreamReader } from './test-stream.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fixture = fileURLToPath(new URL('./__fixtures__/database-publisher.ts', import.meta.url));

/** Runs the publisher as a process of its own; it is killed when the test ends, however it ends. */
function publish(root: string): Promise<{ code: number | null; output: string }> {
  const { NODE_OPTIONS: _options, MARMEON_CLUSTER_WORKER: _mark, ...env } = process.env;
  const child = spawn(process.execPath, ['--conditions=@marmeon/source', fixture, root], { cwd: dirname(fixture), env, stdio: ['ignore', 'pipe', 'pipe'] });
  onTestFinished(() => void child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk));
  child.stderr.on('data', () => undefined);
  const bound = setTimeout(() => child.kill('SIGKILL'), 25_000);
  return new Promise((resolve) =>
    child.once('close', (code) => {
      clearTimeout(bound);
      resolve({ code, output: output.trim().split('\n').at(-1) ?? '' });
    }),
  );
}

/** The web process: a booted app on the temp SQLite file with `driver`, and a stream open on `orders.7`. */
async function webStream(driver: 'database' | 'memory') {
  const directory = tempDir('marmeon-live-processes');
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const target = sqliteTarget(directory);
  const setup = connectionsAt(target);
  await migrate(setup);
  await setup.destroy();
  const logging: Logger = { ...silent, child: () => logging };
  const app = await createApplication(
    { root: directory, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider, LiveServiceProvider] },
    { env: { APP_KEY: generateKey(), NODE_ENV: 'test', LIVE_DRIVER: driver, LIVE_POLL_MILLISECONDS: '50', DB_DRIVER: 'sqlite', DB_DATABASE: join(directory, 'live.sqlite'), DB_MANAGED: 'false' }, override: (container) => container.instance(Logger, logging) },
  );
  cleanups.push(() => app.shutdown());
  const hub = app.container.make(LiveHub);
  await hub.listen();
  const reader = new LiveStreamReader(await hub.open({ channels: ['orders.7'], scope: 'scope-of-adas-session', connection: 'tab-a-0001' }));
  cleanups.push(() => reader.close());
  await reader.hello();
  return { directory, reader };
}

describe('a hint from another process', () => {
  it('reaches the stream of the web process exactly once, through the shared SQLite file', async () => {
    const { directory, reader } = await webStream('database');
    const sent = await publish(directory);
    expect(sent).toEqual({ code: 0, output: expect.stringMatching(/^sent \d+$/) });
    await reader.waitFor(1, { timeout: { seconds: 5 }, what: 'the hint of the publisher process' });
    // Several polls later it is still the one hint: the poller does not deliver a row twice.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(reader.hints).toEqual([{ channel: 'orders.7', only: ['status'], seq: Number(sent.output.slice(5)) }]);
  }, 40_000);

  it('never reaches it with LIVE_DRIVER=memory — the proof that the driver carries it', async () => {
    const { directory, reader } = await webStream('memory');
    const sent = await publish(directory);
    expect(sent.code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(reader.hints).toEqual([]);
  }, 40_000);
});

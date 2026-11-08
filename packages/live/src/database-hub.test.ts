import { rmSync } from 'node:fs';
import { Redactor } from '@marmeon/core';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { connectionsAt, migrate, openBackend, silent, sqliteTarget } from './__fixtures__/database.ts';
import { LiveHub } from './hub.ts';
import { LiveStreamReader } from './test-stream.ts';

const ADA = 'scope-of-adas-session';
const options = { heartbeatSeconds: 20, retryMs: 3000, maxStreams: 10 };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Two processes on one SQLite file: the hub of A, the backend of B. */
async function processes() {
  const directory = tempDir('marmeon-live-hub-');
  const target = sqliteTarget(directory);
  const setup = connectionsAt(target);
  await migrate(setup);
  await setup.destroy();
  const connectionsA = connectionsAt(target);
  const connectionsB = connectionsAt(target);
  const a = openBackend(connectionsA, 'sqlite', { pollMs: 50 });
  const b = openBackend(connectionsB, 'sqlite', { pollMs: 50 });
  const hub = new LiveHub(a, options, silent, undefined, new Redactor());
  cleanups.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => connectionsA.destroy(),
    () => connectionsB.destroy(),
    () => b.close(),
    () => hub.close(),
  );
  await hub.listen();
  return { hub, b };
}

const open = async (hub: LiveHub, lastEventId?: string) => new LiveStreamReader(await hub.open({ channels: ['orders.7'], scope: ADA, connection: 'tab-a-0001', lastEventId }));

describe('a hub on the database backend', () => {
  it('sends the hint of another process as a refresh frame whose seq is the row id', async () => {
    const { hub, b } = await processes();
    const reader = await open(hub);
    cleanups.push(() => reader.close());
    expect(await reader.hello()).toEqual({ seq: { 'orders.7': 0 } });
    const id = await b.refresh('orders.7', ['status'], undefined);
    await reader.waitFor(1);
    expect(reader.hints).toEqual([{ channel: 'orders.7', only: ['status'], seq: id }]);
  });

  it('names a channel as missed when a reconnect carries an older id', async () => {
    const { hub, b } = await processes();
    const watching = await open(hub);
    cleanups.push(() => watching.close());
    const first = await b.refresh('orders.7', null, undefined);
    const second = await b.refresh('orders.7', null, undefined);
    // The hello of the reconnect says what this process has delivered, so wait for the poll.
    await watching.waitFor(2);
    const again = await open(hub, `orders.7=${first}`);
    cleanups.push(() => again.close());
    expect(await again.hello()).toEqual({ seq: { 'orders.7': second }, missed: ['orders.7'] });
  });

  it('closes the streams of a scope when another process ends it', async () => {
    const { hub, b } = await processes();
    const reader = await open(hub);
    await reader.hello();
    await b.end(ADA);
    await reader.closed;
    expect(reader.ended).toBe(true);
    expect(reader.events.at(-1)?.event).toBe('end');
  });
});

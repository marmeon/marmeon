import { rmSync } from 'node:fs';
import { InfrastructureTransactionError, sql } from '@marmeon/database';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { parseMessage } from './backend.ts';
import { LIVE_HINTS_COLUMNS, LIVE_HINTS_TABLE } from './database.ts';
import { connectionsAt, freshPostgres, migrate, openBackend, PGSQL_URL, rows, sqliteTarget, type LiveTarget } from './__fixtures__/database.ts';

const targets: readonly { name: string; run: boolean; fresh: () => Promise<{ target: LiveTarget; drop: () => Promise<void> }> }[] = [
  {
    name: 'SQLite',
    run: true,
    fresh: async () => {
      const directory = tempDir('marmeon-live-db-');
      const target = sqliteTarget(directory);
      const connections = connectionsAt(target);
      await migrate(connections);
      await connections.destroy();
      return { target, drop: async () => rmSync(directory, { recursive: true, force: true }) };
    },
  },
  { name: 'Postgres', run: PGSQL_URL !== undefined, fresh: freshPostgres },
];

for (const { name, run, fresh } of targets) {
  describe.runIf(run)(`the database backend on ${name}`, () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function open() {
      const { target, drop } = await fresh();
      const connections = connectionsAt(target);
      const backend = openBackend(connections, target.driver);
      cleanups.push(drop, () => connections.destroy(), () => backend.close());
      return { connections, backend };
    }

    it('names the table and its columns', () => {
      expect(LIVE_HINTS_TABLE).toBe('live_hints');
      expect(LIVE_HINTS_COLUMNS).toEqual(['id', 'channel', 'message', 'created_at']);
    });

    it('counts one sequence across channels: ids rise and are the seq of the hint', async () => {
      const { backend, connections } = await open();
      const first = await backend.refresh('orders.1', null, undefined);
      const second = await backend.refresh('users.1', ['posts'], undefined);
      const third = await backend.refresh('orders.1', null, 'tab');
      expect(typeof first).toBe('number');
      expect(second).toBeGreaterThan(first);
      expect(third).toBeGreaterThan(second);
      expect((await rows(connections)).map((row) => row.id)).toEqual([first, second, third]);
    });

    it('reports the last id of each channel, and 0 for one without a hint', async () => {
      const { backend } = await open();
      const first = await backend.refresh('orders.1', null, undefined);
      await backend.refresh('users.1', null, undefined);
      const last = await backend.refresh('orders.1', null, undefined);
      const users = (await backend.seqs(['users.1']))[0]!;
      expect(await backend.seqs(['orders.1', 'nothing.9', 'users.1'])).toEqual([last, 0, users]);
      expect(last).toBeGreaterThan(first);
      expect(await backend.seqs([])).toEqual([]);
    });

    it('writes an end as a row without a channel', async () => {
      const { backend, connections } = await open();
      await backend.end('scope-of-ada');
      const [row, ...more] = await rows(connections);
      expect(more).toEqual([]);
      expect(row!.channel).toBeNull();
      expect(parseMessage(row!.message)).toEqual({ kind: 'end', scope: 'scope-of-ada' });
    });

    it('stores the message without a seq; with the id added it is a message', async () => {
      const { backend, connections } = await open();
      const id = await backend.refresh('orders.1', ['status'], 'tab');
      const [row] = await rows(connections);
      expect(row!.channel).toBe('orders.1');
      expect(JSON.parse(row!.message)).toEqual({ v: 1, kind: 'refresh', channel: 'orders.1', only: ['status'], except: 'tab' });
      expect(parseMessage(row!.message)).toBeUndefined();
      expect(parseMessage(`${row!.message.slice(0, -1)},"seq":${id}}`)).toEqual({ kind: 'refresh', channel: 'orders.1', only: ['status'], seq: id, except: 'tab' });
    });

    it('never hands out an id again: after the newest row is deleted, the next one is higher', async () => {
      const { backend, connections } = await open();
      await backend.refresh('orders.1', null, undefined);
      const b = await backend.refresh('orders.1', null, undefined);
      await sql`delete from live_hints where id = ${b}`.execute(connections.get());
      const c = await backend.refresh('orders.1', null, undefined);
      expect(c).toBeGreaterThan(b);
    });
  });
}

describe('the database backend never joins the app’s transaction', () => {
  it('SQLite: a refresh inside an open transaction throws InfrastructureTransactionError', async () => {
    const directory = tempDir('marmeon-live-db-');
    const target = sqliteTarget(directory);
    const connections = connectionsAt(target);
    try {
      await migrate(connections);
      const backend = openBackend(connections, 'sqlite');
      class Rollback extends Error {}
      await expect(
        connections.transaction(async () => {
          await expect(backend.refresh('orders.1', null, undefined)).rejects.toThrow(InfrastructureTransactionError);
          await expect(backend.end('scope')).rejects.toThrow(InfrastructureTransactionError);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(await rows(connections)).toEqual([]);
      await backend.refresh('orders.1', null, undefined);
      expect(await rows(connections)).toHaveLength(1);
    } finally {
      await connections.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

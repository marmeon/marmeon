import { AsyncLocalStorage } from 'node:async_hooks';
import { rmSync } from 'node:fs';
import { InfrastructureTransactionError, sql } from '@marmeon/database';
import { Redactor } from '@marmeon/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { parseMessage, type LiveMessage } from './backend.ts';
import { DatabaseLiveBackend, LIVE_HINTS_COLUMNS, LIVE_HINTS_TABLE } from './database.ts';
import { connectionsAt, freshPostgres, migrate, openBackend, PGSQL_URL, recorder, rows, sqliteTarget, type LiveTarget } from './__fixtures__/database.ts';

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

    describe('polling', () => {
      /** Two processes on one database: each its own connections and backend. */
      async function two(options: { pollMs?: number } = {}) {
        const { target, drop } = await fresh();
        const a = recorder();
        const b = recorder();
        const connectionsA = connectionsAt(target);
        const connectionsB = connectionsAt(target);
        const backendA = openBackend(connectionsA, target.driver, { pollMs: 50, ...options, logger: a.logger });
        const backendB = openBackend(connectionsB, target.driver, { pollMs: 50, ...options, logger: b.logger });
        cleanups.push(drop, () => connectionsA.destroy(), () => connectionsB.destroy(), () => backendA.close(), () => backendB.close());
        const heard: LiveMessage[] = [];
        return { target, connectionsA, connectionsB, backendA, backendB, heard, logsA: a.logs, listenA: () => backendA.listen((message) => heard.push(message)) };
      }

      it('delivers a hint of another process to the listener', async () => {
        const { backendB, heard, listenA } = await two();
        await listenA();
        const id = await backendB.refresh('orders.7', ['status'], undefined);
        await vi.waitFor(() => expect(heard).toEqual([{ kind: 'refresh', channel: 'orders.7', only: ['status'], seq: id }]));
      });

      it('delivers an end of another process', async () => {
        const { backendB, heard, listenA } = await two();
        await listenA();
        await backendB.end('scope-of-ada');
        await vi.waitFor(() => expect(heard).toEqual([{ kind: 'end', scope: 'scope-of-ada' }]));
      });

      it('starts at the newest row: what was written before listen() is not delivered', async () => {
        const { backendB, heard, listenA } = await two();
        await backendB.refresh('orders.7', null, undefined);
        await listenA();
        const after = await backendB.refresh('orders.8', null, undefined);
        await vi.waitFor(() => expect(heard.map((message) => (message as { seq: number }).seq)).toEqual([after]));
      });

      it('delivers what the process itself sent at once, and exactly once', async () => {
        const { backendA, heard, listenA } = await two({ pollMs: 5_000 });
        await listenA();
        const id = await backendA.refresh('orders.7', null, 'tab-1');
        // No poll has run (the interval is 5 s): the listener already heard it.
        expect(heard).toEqual([{ kind: 'refresh', channel: 'orders.7', only: null, seq: id, except: 'tab-1' }]);
      });

      it('delivers its own hint once even when the poller reads the row', async () => {
        const { backendA, backendB, heard, listenA } = await two();
        await listenA();
        const own = await backendA.refresh('orders.7', null, undefined);
        const foreign = await backendB.refresh('orders.7', null, undefined);
        await vi.waitFor(() => expect(heard).toHaveLength(2));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(heard.map((message) => (message as { seq: number }).seq)).toEqual([own, foreign]);
      });

      it('says in hello what the process delivered: a row of another process counts after the poll, its own at once', async () => {
        const { backendA, backendB, heard, listenA } = await two({ pollMs: 3_000 });
        // Both sides warm (connections open, modules loaded), so the poll cannot come between the insert and the first seqs().
        await backendB.refresh('warm.1', null, undefined);
        await backendA.seqs(['warm.1']);
        await listenA();
        const before = await backendB.refresh('orders.7', null, undefined);
        // Not polled yet: the process has not delivered it.
        expect(await backendA.seqs(['orders.7'])).toEqual([0]);
        await vi.waitFor(() => expect(heard).toHaveLength(1), { timeout: 10_000 });
        expect(await backendA.seqs(['orders.7'])).toEqual([before]);
        const own = await backendA.refresh('orders.8', null, undefined);
        expect(await backendA.seqs(['orders.7', 'orders.8'])).toEqual([before, own]);
      });

      it('hears each of its own hints exactly once while the poller reads concurrently', async () => {
        const { backendA, heard, listenA } = await two({ pollMs: 1 });
        await listenA();
        const sent: number[] = [];
        await Promise.all(Array.from({ length: 16 }, async () => {
          for (let index = 0; index < 200; index++) sent.push(await backendA.refresh(`orders.${index % 3}`, null, undefined));
        }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const ids = heard.map((message) => (message as { seq: number }).seq);
        expect([...ids].sort((x, y) => x - y)).toEqual([...sent].sort((x, y) => x - y));
      });

      it('logs a flapping database once per minute, and the recovery only of a streak it logged', async () => {
        const { target, drop } = await fresh();
        const connections = connectionsAt(target);
        const { logger, logs } = recorder();
        let failing = false;
        let calls = 0;
        let time = 1_000_000;
        const backend = new DatabaseLiveBackend(async () => {
          calls++;
          if (failing) throw new Error('database down');
          return { db: connections.infrastructure('default'), driver: target.driver };
        }, { pollMs: 5, logger, redactor: new Redactor(), clock: { now: () => time } });
        cleanups.push(drop, () => connections.destroy(), () => backend.close());
        await backend.listen(() => {});
        const polls = async (count: number) => {
          const until = calls + count;
          await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(until));
        };
        const levels = () => logs.map((log) => log.level);
        failing = true;
        await polls(3);
        expect(levels()).toEqual(['error']);
        failing = false;
        await polls(2);
        expect(levels()).toEqual(['error', 'info']);
        // Down again within the minute: not logged, and its recovery is not announced.
        failing = true;
        await polls(3);
        failing = false;
        await polls(2);
        expect(levels()).toEqual(['error', 'info']);
        time += 60_000;
        failing = true;
        await polls(3);
        failing = false;
        await polls(2);
        expect(levels()).toEqual(['error', 'info', 'error', 'info']);
      });

      it('skips a row that is no message and delivers the next one', async () => {
        const { connectionsB, backendB, heard, logsA, listenA } = await two();
        await listenA();
        await sql`insert into live_hints (channel, message, created_at) values ('orders.7', 'not json', 0), ('orders.7', '{"v":2}', 0)`.execute(connectionsB.get());
        const id = await backendB.refresh('orders.9', null, undefined);
        await vi.waitFor(() => expect(heard).toEqual([{ kind: 'refresh', channel: 'orders.9', only: null, seq: id }]));
        expect(logsA.filter((log) => log.level === 'warn')).toHaveLength(1);
      });

      it('a removed listener hears nothing more, and neither does one after close', async () => {
        const { backendA, backendB, listenA, heard } = await two();
        const second: LiveMessage[] = [];
        const stop = await listenA();
        await backendA.listen((message) => second.push(message));
        await stop();
        await backendB.refresh('orders.7', null, undefined);
        await vi.waitFor(() => expect(second).toHaveLength(1));
        expect(heard).toEqual([]);
        await backendA.refresh('orders.7', null, undefined);
        expect(second).toHaveLength(2);
        expect(heard).toEqual([]);
        await backendA.close();
        await backendB.refresh('orders.7', null, undefined);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(second).toHaveLength(2);
      });

      it('logs a failing poll once, says when it works again, and delivers afterwards without a restart', async () => {
        const { connectionsB, backendB, heard, logsA, listenA, target } = await two();
        await listenA();
        await sql`drop table live_hints`.execute(connectionsB.get());
        await vi.waitFor(() => expect(logsA.filter((log) => log.level === 'error')).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(logsA.filter((log) => log.level === 'error')).toHaveLength(1);
        const recreated = connectionsAt(target);
        try {
          await migrate(recreated);
        } finally {
          await recreated.destroy();
        }
        await vi.waitFor(() => expect(logsA.filter((log) => log.level === 'info')).toHaveLength(1));
        const id = await backendB.refresh('orders.7', null, undefined);
        await vi.waitFor(() => expect(heard).toEqual([{ kind: 'refresh', channel: 'orders.7', only: null, seq: id }]));
      });

      it('runs its queries outside the context of the request that started it', async () => {
        const { connectionsA, backendB, heard, listenA } = await two();
        const store = new AsyncLocalStorage<string>();
        const seen: (string | undefined)[] = [];
        const stop = connectionsA.onQuery(() => seen.push(store.getStore()));
        await store.run('request', listenA);
        await backendB.refresh('orders.7', null, undefined);
        await vi.waitFor(() => expect(heard).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 200));
        stop();
        expect(seen.length).toBeGreaterThan(2);
        expect(seen).toEqual(seen.map(() => undefined));
      });

      it('stops cleanly: its timers do not keep the process alive, and nothing is queried after close()', async () => {
        const timers: NodeJS.Timeout[] = [];
        const original = globalThis.setTimeout;
        const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
          const timer = original(...args);
          if (args[1] === 137) timers.push(timer);
          return timer;
        }) as typeof setTimeout);
        try {
          const { connectionsA, backendA, listenA } = await two({ pollMs: 137 });
          let queries = 0;
          connectionsA.onQuery(() => queries++);
          await listenA();
          await new Promise((resolve) => original(resolve, 400));
          expect(timers.length).toBeGreaterThan(1);
          for (const timer of timers) expect(timer.hasRef()).toBe(false);
          await backendA.close();
          const after = queries;
          await new Promise((resolve) => original(resolve, 400));
          expect(queries).toBe(after);
        } finally {
          spy.mockRestore();
        }
      });
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

describe.runIf(PGSQL_URL !== undefined)('the database backend on Postgres: ids that commit late', () => {
  it('asks again for an id that became visible after a newer one', async () => {
    const { target, drop } = await freshPostgres();
    const slow = connectionsAt(target);
    const other = connectionsAt(target);
    const reader = connectionsAt(target);
    const heard: LiveMessage[] = [];
    const a = openBackend(reader, 'pgsql', { pollMs: 50 });
    const b = openBackend(other, 'pgsql');
    try {
      await a.listen((message) => heard.push(message));
      let commit!: () => void;
      const held = new Promise<void>((resolve) => (commit = resolve));
      let inserted!: () => void;
      const hasInserted = new Promise<void>((resolve) => (inserted = resolve));
      const message = '{"v":1,"kind":"refresh","channel":"orders.1","only":null}';
      // Takes id N inside a transaction it does not commit yet.
      const slowTransaction = slow.transaction(async () => {
        await sql`insert into live_hints (channel, message, created_at) values ('orders.1', ${message}, 0)`.execute(slow.get());
        inserted();
        await held;
      });
      await hasInserted;
      // N + 1 commits first and is polled.
      const newer = await b.refresh('orders.2', null, undefined);
      await vi.waitFor(() => expect(heard).toHaveLength(1));
      expect(heard[0]).toMatchObject({ channel: 'orders.2', seq: newer });
      commit();
      await slowTransaction;
      // N is visible now, below the cursor: the poller asks for it again.
      await vi.waitFor(() => expect(heard).toHaveLength(2));
      expect(heard[1]).toMatchObject({ channel: 'orders.1', seq: newer - 1 });
    } finally {
      await a.close();
      await b.close();
      await slow.destroy();
      await other.destroy();
      await reader.destroy();
      await drop();
    }
  });
});

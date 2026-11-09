import { AsyncLocalStorage } from 'node:async_hooks';
import { rmSync } from 'node:fs';
import { InfrastructureTransactionError, sql } from '@marmeon/database';
import { Redactor, type Clock } from '@marmeon/core';
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

    describe('pruning', () => {
      const MINUTE = 60_000;
      const HOUR = 60 * MINUTE;
      /** A clock that travels: tests move `time`. */
      const travelling = () => ({ time: 1_700_000_000_000, now() { return this.time; } });
      const count = async (connections: Awaited<ReturnType<typeof open>>['connections']) => (await rows(connections)).length;

      async function pruner() {
        const { target, drop } = await fresh();
        const clock = travelling();
        const connections = connectionsAt(target);
        const backend = openBackend(connections, target.driver, { clock });
        cleanups.push(drop, () => connections.destroy(), () => backend.close());
        return { clock, connections, backend };
      }

      it('removes end rows after five minutes and keeps younger ones', async () => {
        const { clock, connections, backend } = await pruner();
        await backend.end('old');
        clock.time += 4 * MINUTE;
        await backend.end('young');
        clock.time += 2 * MINUTE;
        expect(await backend.prune()).toBe(1);
        expect((await rows(connections)).map((row) => parseMessage(row.message))).toEqual([{ kind: 'end', scope: 'young' }]);
      });

      it('removes the refresh rows a newer one of their channel replaced, and keeps the newest of every channel', async () => {
        const { clock, connections, backend } = await pruner();
        await backend.refresh('orders.1', null, undefined);
        await backend.refresh('orders.1', null, undefined);
        const newest = await backend.refresh('orders.1', null, undefined);
        const lone = await backend.refresh('orders.2', null, undefined);
        clock.time += 6 * MINUTE;
        expect(await backend.prune()).toBe(2);
        expect((await rows(connections)).map((row) => row.id)).toEqual([newest, lone]);
        expect(await backend.seqs(['orders.1', 'orders.2'])).toEqual([newest, lone]);
      });

      it('never prunes a row younger than five minutes, even when a newer one replaced it', async () => {
        const { clock, connections, backend } = await pruner();
        await backend.refresh('orders.1', null, undefined);
        await backend.refresh('orders.1', null, undefined);
        clock.time += 4 * MINUTE;
        expect(await backend.prune()).toBe(0);
        expect(await count(connections)).toBe(2);
      });

      it('keeps a lone refresh row for a day', async () => {
        const { clock, connections, backend } = await pruner();
        await backend.refresh('orders.1', null, undefined);
        clock.time += 23 * HOUR;
        expect(await backend.prune()).toBe(0);
        clock.time += 2 * HOUR;
        expect(await backend.prune()).toBe(1);
        expect(await count(connections)).toBe(0);
      });

      it('removes a bounded batch per rule and run', async () => {
        const { clock, connections, backend } = await pruner();
        await sql`with recursive n(i) as (select 1 union all select i + 1 from n where i < 2500)
          insert into live_hints (channel, message, created_at) select null, '{"v":1,"kind":"end","scope":"x"}', ${clock.time} from n`.execute(connections.get());
        clock.time += 6 * MINUTE;
        expect(await backend.prune()).toBe(1000);
        expect(await backend.prune()).toBe(1000);
        expect(await backend.prune()).toBe(500);
        expect(await count(connections)).toBe(0);
      });

      it('never hands out an id again after real prunes, even when the newest row went', async () => {
        const { clock, connections, backend } = await pruner();
        await backend.refresh('orders.1', null, undefined);
        const newest = await backend.refresh('orders.2', null, undefined);
        clock.time += 25 * HOUR;
        expect(await backend.prune()).toBe(2);
        expect(await count(connections)).toBe(0);
        expect(await backend.refresh('orders.1', null, undefined)).toBeGreaterThan(newest);
      });

      it('prunes by itself about once a minute, in the root context', async () => {
        const { target, drop } = await fresh();
        const clock = travelling();
        const connections = connectionsAt(target);
        const backend = openBackend(connections, target.driver, { clock, pollMs: 20 });
        cleanups.push(drop, () => connections.destroy(), () => backend.close());
        await backend.end('old');
        clock.time += 6 * MINUTE;
        const store = new AsyncLocalStorage<string>();
        const deletes: (string | undefined)[] = [];
        const stop = connections.onQuery((query) => void (query.sql.startsWith('delete') && deletes.push(store.getStore())));
        await store.run('request', () => backend.listen(() => {}));
        // The three deletes of one run (the last rule runs after the table is already empty).
        await vi.waitFor(() => expect(deletes).toHaveLength(3));
        expect(await count(connections)).toBe(0);
        expect(deletes).toEqual(deletes.map(() => undefined));
        // Another old row: not before a minute (at most 72 s with the jitter) has passed.
        await sql`insert into live_hints (channel, message, created_at) values (null, '{"v":1,"kind":"end","scope":"x"}', 0)`.execute(connections.get());
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await count(connections)).toBe(1);
        clock.time += 73_000;
        await vi.waitFor(async () => expect(await count(connections)).toBe(0));
        stop();
      });

      it('loses and doubles no hint when it prunes while the poller reads', async () => {
        const { target, drop } = await fresh();
        const clock = travelling();
        const connectionsA = connectionsAt(target);
        const connectionsB = connectionsAt(target);
        const a = openBackend(connectionsA, target.driver, { clock, pollMs: 1 });
        const b = openBackend(connectionsB, target.driver, { clock });
        cleanups.push(drop, () => connectionsA.destroy(), () => connectionsB.destroy(), () => a.close(), () => b.close());
        const heard: LiveMessage[] = [];
        await a.listen((message) => heard.push(message));
        const sent: number[] = [];
        for (let index = 0; index < 30; index++) sent.push(await b.refresh(`orders.${index % 3}`, null, undefined));
        await vi.waitFor(() => expect(heard).toHaveLength(30));
        // Everything so far is old: the prunes below remove what was superseded while new hints come in.
        clock.time += 6 * MINUTE;
        const prunes = (async () => {
          for (let run = 0; run < 25; run++) {
            await a.prune();
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })();
        await Promise.all(Array.from({ length: 8 }, async () => {
          for (let index = 0; index < 40; index++) sent.push(await b.refresh(`orders.${index % 3}`, null, undefined));
        }));
        await vi.waitFor(() => expect(heard).toHaveLength(sent.length), { timeout: 10_000 });
        await prunes;
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(heard.map((message) => (message as { seq: number }).seq).sort((x, y) => x - y)).toEqual([...sent].sort((x, y) => x - y));
      });

      /** A listening process A (cursor above 0) and a B, on a database whose table is then dropped and made again. */
      async function recreating() {
        const { target, drop } = await fresh();
        const connectionsA = connectionsAt(target);
        const connectionsB = connectionsAt(target);
        const a = recorder();
        const backendA = openBackend(connectionsA, target.driver, { pollMs: 20, logger: a.logger });
        const backendB = openBackend(connectionsB, target.driver);
        cleanups.push(drop, () => connectionsA.destroy(), () => connectionsB.destroy(), () => backendA.close(), () => backendB.close());
        for (let index = 0; index < 3; index++) await backendB.refresh('orders.1', null, undefined);
        const heard: LiveMessage[] = [];
        await backendA.listen((message) => heard.push(message));
        const recreate = async () => {
          await sql`drop table live_hints`.execute(connectionsB.get());
          await migrate(connectionsB);
        };
        return { backendA, backendB, connectionsB, heard, logs: a.logs, recreate };
      }
      const restarted = (logs: { level: string; message: string }[]) => logs.filter((log) => log.message.includes('started again')).length;

      it('hears the first hint after the table started again, although its id is below the old cursor', async () => {
        const { backendB, heard, logs, recreate } = await recreating();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await recreate();
        const first = await backendB.refresh('orders.1', null, undefined);
        expect(first).toBeLessThan(3);
        await vi.waitFor(() => expect(heard).toEqual([{ kind: 'refresh', channel: 'orders.1', only: null, seq: first }]));
        const second = await backendB.refresh('orders.1', null, undefined);
        await vi.waitFor(() => expect(heard).toHaveLength(2));
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(heard.map((message) => (message as { seq: number }).seq)).toEqual([first, second]);
        expect(restarted(logs)).toBe(1);
      });

      it('notices a table that started again once its first row exists, and hears that row', async () => {
        const { backendB, heard, logs, recreate } = await recreating();
        await recreate();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(heard).toEqual([]);
        expect(restarted(logs)).toBe(0);
        expect(logs.some((log) => log.message.includes('cannot be read'))).toBe(false);
        const first = await backendB.refresh('orders.1', null, undefined);
        await vi.waitFor(() => expect(heard).toEqual([{ kind: 'refresh', channel: 'orders.1', only: null, seq: first }]));
        expect(restarted(logs)).toBe(1);
      });

      it('prunes an old end row that is the newest row without taking the table for a new one', async () => {
        const { target, drop } = await fresh();
        const clock = travelling();
        const connections = connectionsAt(target);
        const logs = recorder();
        const backend = openBackend(connections, target.driver, { clock, pollMs: 20, logger: logs.logger });
        const other = openBackend(connections, target.driver, { clock });
        cleanups.push(drop, () => connections.destroy(), () => backend.close(), () => other.close());
        const heard: LiveMessage[] = [];
        await backend.listen((message) => heard.push(message));
        await other.end('scope');
        await vi.waitFor(() => expect(heard).toHaveLength(1));
        clock.time += 6 * MINUTE;
        // The loop's own prune may get there first.
        await backend.prune();
        expect(await count(connections)).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(restarted(logs.logs)).toBe(0);
        const id = await other.refresh('orders.1', null, undefined);
        await vi.waitFor(() => expect(heard).toHaveLength(2));
        expect(heard[1]).toMatchObject({ seq: id });
        expect(restarted(logs.logs)).toBe(0);
      });
    });

    describe('polling', () => {
      const MINUTE = 60_000;
      /** Two processes on one database: each its own connections and backend. */
      async function two(options: { pollMs?: number; clock?: Clock } = {}) {
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
      }, 30_000);

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
          await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(until), { timeout: 10_000 });
        };
        const levels = () => logs.map((log) => log.level);
        failing = true;
        await polls(3);
        expect(levels()).toEqual(['error']);
        failing = false;
        // A round that works asks for the connection twice (the read, then the id counter) and logs after both: wait for the line itself.
        await vi.waitFor(() => expect(levels()).toEqual(['error', 'info']), { timeout: 10_000 });
        // Down again within the minute: not logged, and its recovery is not announced.
        failing = true;
        await polls(3);
        failing = false;
        // The third call comes after the first good round has read, so whatever that round logs is logged by then.
        await polls(3);
        expect(levels()).toEqual(['error', 'info']);
        time += 60_000;
        failing = true;
        await polls(3);
        failing = false;
        await vi.waitFor(() => expect(levels()).toEqual(['error', 'info', 'error', 'info']), { timeout: 10_000 });
      }, 30_000);

      it('a failing prune is logged, and does not make the next poll announce a recovery', async () => {
        const { backendA, logsA, listenA } = await two({ pollMs: 10 });
        const prune = vi.spyOn(backendA, 'prune').mockRejectedValue(new Error('cannot delete'));
        await listenA();
        await vi.waitFor(() => expect(prune).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(logsA.map((log) => log.level)).toEqual(['error']);
        expect(logsA[0]!.message).toContain('Pruning');
      });

      describe('after polls failed, or ids went unseen', () => {
        /** A reads through a connection that can be made to fail; B writes; both share one clock that travels. */
        async function stalled() {
          const { target, drop } = await fresh();
          const clock = { time: 1_700_000_000_000, now() { return this.time; } };
          const connectionsA = connectionsAt(target);
          const connectionsB = connectionsAt(target);
          let failing = false;
          const backendA = new DatabaseLiveBackend(async () => {
            if (failing) throw new Error('database down');
            return { db: connectionsA.infrastructure('default'), driver: target.driver };
          }, { pollMs: 10, logger: recorder().logger, redactor: new Redactor(), clock });
          const backendB = openBackend(connectionsB, target.driver, { clock });
          cleanups.push(drop, () => connectionsA.destroy(), () => connectionsB.destroy(), () => backendA.close(), () => backendB.close());
          const heard: LiveMessage[] = [];
          await backendA.listen((message) => heard.push(message));
          const fail = async (on: boolean) => {
            failing = on;
            await new Promise((resolve) => setTimeout(resolve, 80));
          };
          return { clock, connectionsB, backendB, heard, fail };
        }
        const only = (message: LiveMessage | undefined) => (message as { only: unknown }).only;

        it('a short stall keeps the props a hint names', async () => {
          const { clock, backendB, heard, fail } = await stalled();
          await fail(true);
          await backendB.refresh('orders.1', ['status'], undefined);
          clock.time += MINUTE;
          await fail(false);
          await vi.waitFor(() => expect(heard).toHaveLength(1));
          expect(only(heard[0])).toEqual(['status']);
        });

        it('after a stall longer than rows are kept, the first hints tell every prop to reload; later ones are as sent', async () => {
          const { clock, backendB, heard, fail } = await stalled();
          await fail(true);
          await backendB.refresh('orders.1', ['status'], undefined);
          clock.time += 6 * MINUTE;
          await fail(false);
          await vi.waitFor(() => expect(heard).toHaveLength(1));
          expect(only(heard[0])).toBeNull();
          await backendB.refresh('orders.1', ['status'], undefined);
          await vi.waitFor(() => expect(heard).toHaveLength(2));
          expect(only(heard[1])).toEqual(['status']);
        });

        it('keeps telling every prop to reload while the backlog of the stall comes in batches', async () => {
          const { clock, connectionsB, heard, fail } = await stalled();
          await fail(true);
          await sql`with recursive n(i) as (select 1 union all select i + 1 from n where i < 1500)
            insert into live_hints (channel, message, created_at)
            select 'orders.' || i, '{"v":1,"kind":"refresh","channel":"orders.' || i || '","only":["status"]}', ${clock.time} from n`.execute(connectionsB.get());
          clock.time += 6 * MINUTE;
          await fail(false);
          await vi.waitFor(() => expect(heard).toHaveLength(1500), { timeout: 10_000 });
          expect(heard.every((message) => only(message) === null)).toBe(true);
        });

        it('after an id never showed up, the next hint tells every prop to reload', async () => {
          const { clock, connectionsB, backendB, heard, fail } = await stalled();
          await fail(true);
          const first = await backendB.refresh('orders.1', ['a'], undefined);
          const gone = await backendB.refresh('orders.1', ['b'], undefined);
          await backendB.refresh('orders.2', ['c'], undefined);
          await sql`delete from live_hints where id = ${gone}`.execute(connectionsB.get());
          await fail(false);
          await vi.waitFor(() => expect(heard).toHaveLength(2));
          expect(heard.map((message) => only(message))).toEqual([['a'], ['c']]);
          expect(first).toBeLessThan(gone);
          // Ten seconds pass without the id: it is given up, and what comes next is widened.
          clock.time += 11_000;
          await new Promise((resolve) => setTimeout(resolve, 80));
          await backendB.refresh('orders.1', ['d'], undefined);
          await vi.waitFor(() => expect(heard).toHaveLength(3));
          expect(only(heard[2])).toBeNull();
        });
      });

      it('skips a row that is no message and delivers the next one', async () => {
        const { connectionsB, backendB, heard, logsA, listenA } = await two();
        await listenA();
        const now = Date.now();
        await sql`insert into live_hints (channel, message, created_at) values ('orders.7', 'not json', ${now}), ('orders.7', '{"v":2}', ${now})`.execute(connectionsB.get());
        // A's first round prunes, possibly before it reads these rows; pruned here too, so that window is tested every run: young rows survive it.
        await backendB.prune();
        expect((await rows(connectionsB)).map((row) => row.message)).toEqual(['not json', '{"v":2}']);
        const id = await backendB.refresh('orders.9', null, undefined);
        await vi.waitFor(() => expect(heard).toEqual([{ kind: 'refresh', channel: 'orders.9', only: null, seq: id }]), { timeout: 10_000 });
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
        // One whole round (read and the prune of the first one) finishes before the table goes, so the failure is the poll's.
        await backendB.refresh('orders.7', null, undefined);
        await backendB.refresh('orders.7', null, undefined);
        await vi.waitFor(() => expect(heard).toHaveLength(2), { timeout: 10_000 });
        await new Promise((resolve) => setTimeout(resolve, 150));
        heard.length = 0;
        await sql`drop table live_hints`.execute(connectionsB.get());
        await vi.waitFor(() => expect(logsA.filter((log) => log.level === 'error')).toHaveLength(1), { timeout: 10_000 });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(logsA.filter((log) => log.level === 'error')).toHaveLength(1);
        const recreated = connectionsAt(target);
        try {
          await migrate(recreated);
        } finally {
          await recreated.destroy();
        }
        await vi.waitFor(() => expect(logsA.filter((log) => log.level === 'info')).toHaveLength(1), { timeout: 10_000 });
        const id = await backendB.refresh('orders.7', null, undefined);
        await vi.waitFor(() => expect(heard).toEqual([{ kind: 'refresh', channel: 'orders.7', only: null, seq: id }]), { timeout: 10_000 });
      }, 30_000);

      it('announces the recovery of a poll failure that came right behind a logged prune failure', async () => {
        const { target, drop } = await fresh();
        const connections = connectionsAt(target);
        const { logger, logs } = recorder();
        let failing = false;
        let calls = 0;
        const backend = new DatabaseLiveBackend(async () => {
          calls++;
          if (failing) throw new Error('database down');
          return { db: connections.infrastructure('default'), driver: target.driver };
        }, { pollMs: 5, logger, redactor: new Redactor(), clock: { now: () => 1_000_000 } });
        cleanups.push(drop, () => connections.destroy(), () => backend.close());
        // The database goes down in the very prune that fails, so the next round's read fails right behind the logged error.
        vi.spyOn(backend, 'prune').mockImplementationOnce(async () => {
          failing = true;
          throw new Error('cannot delete');
        });
        await backend.listen(() => {});
        await vi.waitFor(() => expect(logs.map((log) => log.level)).toEqual(['error']), { timeout: 10_000 });
        expect(logs[0]!.message).toContain('Pruning');
        // The poll fails within the minute of that line, so it is not logged itself; its recovery still follows the logged error.
        const until = calls + 3;
        await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(until), { timeout: 10_000 });
        failing = false;
        await vi.waitFor(() => expect(logs.map((log) => log.level)).toEqual(['error', 'info']), { timeout: 10_000 });
      }, 30_000);

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
        await sql`insert into live_hints (channel, message, created_at) values ('orders.1', ${message}, ${Date.now()})`.execute(slow.get());
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
      // A prune of the reader may come first: N is young, so it stays.
      await b.prune();
      expect((await rows(other)).map((row) => row.id)).toEqual([newer - 1, newer]);
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

describe.runIf(PGSQL_URL !== undefined)('the database backend on Postgres as a role that cannot read the id counter', () => {
  it('does not take the table for a new one: nothing is delivered twice while it idles', async () => {
    const { target, drop } = await freshPostgres();
    const owner = connectionsAt(target);
    const role = `marmeon_live_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const admin = connectionsAt({ driver: 'pgsql', url: PGSQL_URL! });
    let restricted: ReturnType<typeof connectionsAt> | undefined;
    let backend: ReturnType<typeof openBackend> | undefined;
    const producer = openBackend(owner, 'pgsql');
    try {
      await sql`create role ${sql.id(role)} login password 'secret'`.execute(admin.get());
      await sql`grant select, insert, delete on live_hints to ${sql.id(role)}`.execute(owner.get());
      const url = new URL((target as { url: string }).url);
      url.username = role;
      url.password = 'secret';
      restricted = connectionsAt({ driver: 'pgsql', url: url.href });
      const logs = recorder();
      backend = openBackend(restricted, 'pgsql', { pollMs: 20, logger: logs.logger });
      for (let index = 0; index < 3; index++) await producer.refresh('orders.1', null, undefined);
      const heard: LiveMessage[] = [];
      await backend.listen((message) => heard.push(message));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(heard).toEqual([]);
      expect(logs.logs.filter((log) => log.message.includes('started again'))).toEqual([]);
      expect(logs.logs.filter((log) => log.message.includes('cannot be read'))).toHaveLength(1);
      const id = await producer.refresh('orders.1', null, undefined);
      await vi.waitFor(() => expect(heard).toEqual([{ kind: 'refresh', channel: 'orders.1', only: null, seq: id }]));
    } finally {
      await backend?.close();
      await producer.close();
      await restricted?.destroy();
      await owner.destroy();
      // The role goes after the database (its grant lives there), and goes even when dropping the database fails.
      try {
        await drop();
      } finally {
        await sql`drop role if exists ${sql.id(role)}`.execute(admin.get());
        await admin.destroy();
      }
    }
  });
});

describe('the database backend on a SQLite table without AUTOINCREMENT', () => {
  it('does not take the table for a new one: nothing is delivered twice while it idles', async () => {
    const directory = tempDir('marmeon-live-db-');
    const connections = connectionsAt(sqliteTarget(directory));
    const logs = recorder();
    const backend = openBackend(connections, 'sqlite', { pollMs: 20, logger: logs.logger });
    try {
      await sql`create table live_hints (id integer primary key, channel varchar(200), message text not null, created_at bigint not null)`.execute(connections.get());
      for (let index = 0; index < 3; index++) await backend.refresh('orders.1', null, undefined);
      const heard: LiveMessage[] = [];
      await backend.listen((message) => heard.push(message));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(heard).toEqual([]);
      expect(logs.logs.filter((log) => log.message.includes('started again'))).toEqual([]);
      expect(logs.logs.filter((log) => log.message.includes('cannot be read'))).toHaveLength(1);
    } finally {
      await backend.close();
      await connections.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

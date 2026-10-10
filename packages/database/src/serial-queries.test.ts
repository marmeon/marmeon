import { setTimeout as sleep } from 'node:timers/promises';
import { CompiledQuery, sql, type DatabaseConnection, type Driver, type QueryResult } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { MarmeonDriver, serialQueries } from './driver.ts';
import type { Connections } from './index.ts';

// One query at a time per connection: a transaction's connection and a test's isolated one are shared by everything
// running inside them — `Promise.all` over a page's props, two requests of a test. `pg` warns about a query sent while another is
// under way ("client.query() when the client is already executing a query") and pg 9 refuses it.

/** A connection that counts how many of its queries run at once — with a private field, as the drivers' connections have. */
class CountingConnection implements DatabaseConnection {
  readonly #log: string[];
  running = 0;
  most = 0;

  constructor(log: string[]) {
    this.#log = log;
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    this.running++;
    this.most = Math.max(this.most, this.running);
    try {
      this.#log.push(`start ${query.sql}`);
      await sleep(query.sql.startsWith('slow') ? 15 : 1);
      if (query.sql.startsWith('fail')) throw new Error(`${query.sql} failed`);
      return { rows: [{ sql: query.sql }] as R[] };
    } finally {
      this.#log.push(`end ${query.sql}`);
      this.running--;
    }
  }

  async *streamQuery<R>(query: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    this.running++;
    this.most = Math.max(this.most, this.running);
    try {
      for (const chunk of ['a', 'b']) {
        await sleep(5);
        yield { rows: [{ sql: `${query.sql} ${chunk}` }] as R[] };
      }
    } finally {
      this.running--;
    }
  }

  release(): string {
    return `released after ${this.#log.length} entries`;
  }
}

const raw = (text: string) => CompiledQuery.raw(text);

describe('serialQueries()', () => {
  it('runs the queries of one connection one at a time, in the order they were sent', async () => {
    const log: string[] = [];
    const inner = new CountingConnection(log);
    const connection = serialQueries(inner);
    const results = await Promise.all(['slow 1', 'two', 'three'].map((text) => connection.executeQuery(raw(text))));
    expect(results.map((result) => (result.rows[0] as { sql: string }).sql)).toEqual(['slow 1', 'two', 'three']);
    expect(inner.most).toBe(1);
    expect(log).toEqual(['start slow 1', 'end slow 1', 'start two', 'end two', 'start three', 'end three']);
  });

  it('passes the turn on after a failed query — its error goes to its caller only', async () => {
    const inner = new CountingConnection([]);
    const connection = serialQueries(inner);
    const [failed, next] = await Promise.allSettled([connection.executeQuery(raw('fail 1')), connection.executeQuery(raw('after'))]);
    expect(failed).toMatchObject({ status: 'rejected', reason: { message: 'fail 1 failed' } });
    expect(next).toMatchObject({ status: 'fulfilled' });
    expect(inner.most).toBe(1);
  });

  it('holds the turn for a stream until it ends — a query sent meanwhile waits', async () => {
    const inner = new CountingConnection([]);
    const connection = serialQueries(inner);
    const chunks: string[] = [];
    const streaming = (async () => {
      for await (const chunk of connection.streamQuery(raw('stream'), 1)) chunks.push((chunk.rows[0] as { sql: string }).sql);
      chunks.push('stream ended');
    })();
    await sleep(1);
    const query = connection.executeQuery(raw('query')).then(() => chunks.push('query'));
    await Promise.all([streaming, query]);
    expect(chunks).toEqual(['stream a', 'stream b', 'stream ended', 'query']);
    expect(inner.most).toBe(1);
  });

  it('is the connection for everything else — methods bound to it (private fields), one wrapper per connection', async () => {
    const inner = new CountingConnection(['x']);
    const connection = serialQueries(inner) as DatabaseConnection & { release(): string };
    expect(connection.release()).toBe('released after 1 entries');
  });
});

/** The dialect's driver: hands out one connection and runs the transaction statements on whatever it is given. */
function fakeDriver(connection: DatabaseConnection): Driver {
  return {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async (given) => void (await given.executeQuery(raw('begin'))),
    commitTransaction: async (given) => void (await given.executeQuery(raw('commit'))),
    rollbackTransaction: async (given) => void (await given.executeQuery(raw('rollback'))),
    releaseConnection: async () => {},
    destroy: async () => {},
  };
}

describe('the MarmeonDriver hands out connections whose queries take turns', () => {
  it('a test’s isolated connection: two "requests" at once never overlap on it — the transaction statements included', async () => {
    const log: string[] = [];
    const inner = new CountingConnection(log);
    const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', target: 'fake' });
    const isolation = await driver.isolate();
    const [first, second] = await Promise.all([driver.acquireConnection(), driver.acquireConnection()]);
    expect(first).toBe(second);
    await Promise.all([first.executeQuery(raw('slow request 1')), second.executeQuery(raw('request 2')), driver.beginTransaction(first, {})]);
    expect(inner.most).toBe(1);
    await isolation.rollback();
    expect(log.at(-2)).toBe('start rollback');
  });

  it('a connection of its own (the pool) is wrapped once, the same wrapper every time', async () => {
    const inner = new CountingConnection([]);
    const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', target: 'fake' });
    const first = await driver.acquireConnection();
    await driver.releaseConnection(first);
    const second = await driver.acquireConnection();
    expect(second).toBe(first);
    expect(second).not.toBe(inner);
    await Promise.all([second.executeQuery(raw('slow one')), second.executeQuery(raw('two'))]);
    expect(inner.most).toBe(1);
  });
});

describe.each(drivers)('one query at a time on a shared connection on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  /** On Postgres: the most queries one `pg` client had under way at once (what pg 8 warns about, pg 9 refuses). */
  let most = 0;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    if (driver !== 'pgsql') return;
    const { default: pg } = await import('pg');
    const running = new WeakMap<object, number>();
    const query = pg.Client.prototype.query;
    vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: object, ...args: unknown[]) {
      const now = (running.get(this) ?? 0) + 1;
      running.set(this, now);
      most = Math.max(most, now);
      const done = () => running.set(this, (running.get(this) ?? 1) - 1);
      const result = (query as (...args: unknown[]) => unknown).apply(this, args);
      if (result instanceof Promise) void result.then(done, done);
      else done();
      return result;
    } as typeof query);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await close();
  });

  const twenty = () => Promise.all(Array.from({ length: 20 }, (_, i) => sql<{ n: number | string }>`select ${i} as n`.execute(connections.get()).then(({ rows }) => Number(rows[0]!.n))));

  it('Promise.all inside a transaction — all answered, in order, never two at once on its connection', async () => {
    most = 0;
    const numbers = await connections.transaction(() => twenty());
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i));
    if (driver === 'pgsql') expect(most).toBe(1);
  });

  it('Promise.all on a test’s isolated connection — two requests at once', async () => {
    most = 0;
    const isolation = await connections.isolate();
    try {
      const [a, b] = await Promise.all([twenty(), twenty()]);
      expect(a).toEqual(b);
    } finally {
      await isolation.rollback();
    }
    if (driver === 'pgsql') expect(most).toBe(1);
  });
});

import { setTimeout as sleep } from 'node:timers/promises';
import { CompiledQuery, sql, type DatabaseConnection, type Driver, type QueryResult } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TransactionError } from '@marmeon/core';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { MarmeonDriver, serialQueries } from './driver.ts';
import { controlOf } from './mysql-transaction-control.ts';
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

  it('runs the result hook once per result when a wrapper is assigned over the proxy, as the query log does', async () => {
    const inner = new CountingConnection([]);
    const hook = vi.fn();
    const connection = serialQueries(inner, { result: hook });
    // Kysely's query log: capture the connection's method, then assign a wrapper that calls it.
    const execute = connection.executeQuery;
    connection.executeQuery = (query) => execute.call(connection, query) as never;
    const stream = connection.streamQuery;
    connection.streamQuery = (query, chunkSize) => stream.call(connection, query, chunkSize) as never;

    await connection.executeQuery(raw('one'));
    expect(hook).toHaveBeenCalledTimes(1);

    hook.mockClear();
    for await (const _chunk of connection.streamQuery(raw('stream'), 1)) void _chunk;
    expect(hook).toHaveBeenCalledTimes(2); // its two chunks, each once
  });

  it('asks the refuse hook on a query’s turn and fails it with the hook’s error, never reaching the connection — for a query and for a stream', async () => {
    const log: string[] = [];
    const inner = new CountingConnection(log);
    const refusal = new Error('refused');
    const connection = serialQueries(inner, { refuse: (query) => (query.sql.startsWith('no') ? refusal : undefined) });
    const [refused, passed, refusedStream] = await Promise.allSettled([
      connection.executeQuery(raw('no 1')),
      connection.executeQuery(raw('yes')),
      (async () => {
        for await (const _chunk of connection.streamQuery(raw('no stream'), 1)) void _chunk;
      })(),
    ]);
    expect(refused).toMatchObject({ status: 'rejected', reason: refusal });
    expect(refusedStream).toMatchObject({ status: 'rejected', reason: refusal });
    expect(passed.status).toBe('fulfilled');
    // Only the query that was not refused reached the connection, and the turn went on after each refusal.
    expect(log).toEqual(['start yes', 'end yes']);
    for await (const _chunk of connection.streamQuery(raw('yes stream'), 1)) void _chunk;
  });

  it('asks the refuse hook when the query’s turn comes, so what an earlier query set is seen — also for queries sent without waiting', async () => {
    const inner = new CountingConnection([]);
    let armed = false;
    const connection = serialQueries(inner, {
      refuse: (query) => (armed && query.sql.startsWith('no') ? new Error('refused') : undefined),
      passed: (query) => void (armed ||= query.sql === 'arm'),
    });
    // Nothing is awaited between them: the second asks only after the first ran.
    const [arm, refused] = await Promise.allSettled([connection.executeQuery(raw('arm')), connection.executeQuery(raw('no query'))]);
    expect(arm.status).toBe('fulfilled');
    expect(refused).toMatchObject({ status: 'rejected', reason: { message: 'refused' } });
    // The same for a stream, sent right behind a query that disarms.
    const disarm = serialQueries(inner, {
      refuse: () => (armed ? new Error('stream refused') : undefined),
      passed: (query) => void (armed = query.sql === 'arm again'),
    });
    armed = false;
    const streaming = (async () => {
      for await (const _chunk of disarm.streamQuery(raw('no stream'), 1)) void _chunk;
    })();
    const [, refusedStream] = await Promise.allSettled([disarm.executeQuery(raw('arm again')), streaming]);
    expect(refusedStream).toMatchObject({ status: 'rejected', reason: { message: 'stream refused' } });
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
    const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', driver: 'sqlite', target: 'fake' });
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
    const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', driver: 'sqlite', target: 'fake' });
    const first = await driver.acquireConnection();
    await driver.releaseConnection(first);
    const second = await driver.acquireConnection();
    expect(second).toBe(first);
    expect(second).not.toBe(inner);
    await Promise.all([second.executeQuery(raw('slow one')), second.executeQuery(raw('two'))]);
    expect(inner.most).toBe(1);
  });
});

// MySQL commits a transaction at a schema change: the builder's, which Marmeon sees as a node, is refused inside one before it is sent.
describe('on MySQL, the MarmeonDriver', () => {
  const schemaChange = (text: string, kind = 'CreateTableNode', more: object = {}) => ({ ...raw(text), query: { kind, ...more } }) as unknown as CompiledQuery;
  /** What reached the connection, with the mark of the driver's own transaction statements. */
  function recording() {
    const sent: Array<{ sql: string; control: unknown }> = [];
    const inner = {
      executeQuery: async (query: CompiledQuery) => {
        sent.push({ sql: query.sql, control: controlOf(query.parameters) });
        return { rows: [] };
      },
      streamQuery: async function* () {},
    } as unknown as DatabaseConnection;
    return { sent, inner };
  }
  const refusal = /^\[marmeon:D30\] MySQL commits a transaction at a schema change/;

  it('refuses a schema change of the builder inside a transaction, before it is sent, and sends it outside of one', async () => {
    const { sent, inner } = recording();
    const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', driver: 'mysql', target: 'fake' });
    const connection = await driver.acquireConnection();
    await connection.executeQuery(schemaChange('create table before_it (id int)'));
    await driver.beginTransaction(connection, {});
    await expect(connection.executeQuery(schemaChange('create table inside (id int)'))).rejects.toThrow(refusal);
    await expect(connection.executeQuery(schemaChange('create table inside (id int)'))).rejects.toBeInstanceOf(TransactionError);
    await connection.executeQuery(raw('insert into t values (1)'));
    // A savepoint of a nested transaction is no outside either.
    await driver.beginTransaction(connection, {});
    await expect(connection.executeQuery(schemaChange('create table nested (id int)'))).rejects.toThrow(refusal);
    await driver.rollbackTransaction(connection);
    await driver.commitTransaction(connection);
    await connection.executeQuery(schemaChange('create table after_it (id int)'));
    expect(sent.map((statement) => statement.sql)).toEqual(['create table before_it (id int)', 'begin', 'insert into t values (1)', 'savepoint marmeon_savepoint_1', 'rollback to savepoint marmeon_savepoint_1', 'commit', 'create table after_it (id int)']);
  });

  it('refuses every kind of schema change of the builder inside a transaction, and none outside; a temporary table is no schema change to MySQL', async () => {
    const kinds = ['CreateTableNode', 'AlterTableNode', 'DropTableNode', 'CreateIndexNode', 'DropIndexNode', 'CreateViewNode', 'DropViewNode', 'CreateSchemaNode', 'DropSchemaNode'];
    const { sent, inner } = recording();
    const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', driver: 'mysql', target: 'fake' });
    const connection = await driver.acquireConnection();
    for (const kind of kinds) await connection.executeQuery(schemaChange(`outside ${kind}`, kind));
    await driver.beginTransaction(connection, {});
    for (const kind of kinds) await expect(connection.executeQuery(schemaChange(`inside ${kind}`, kind)), kind).rejects.toThrow(refusal);
    await connection.executeQuery(schemaChange('create temporary table scratch (id int)', 'CreateTableNode', { temporary: true }));
    await connection.executeQuery(schemaChange('drop temporary table scratch', 'DropTableNode', { temporary: true }));
    await connection.executeQuery(raw('insert into t values (1)'));
    await driver.commitTransaction(connection);
    expect(sent.map((statement) => statement.sql)).toEqual([
      ...kinds.map((kind) => `outside ${kind}`),
      'begin',
      'create temporary table scratch (id int)',
      'drop temporary table scratch',
      'insert into t values (1)',
      'commit',
    ]);
  });

  it('refuses a schema change under isolate() too, where a test’s statements are in one transaction, and lets the rows of a test through', async () => {
    const { sent, inner } = recording();
    const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', driver: 'mysql', target: 'fake' });
    const isolation = await driver.isolate();
    const connection = await driver.acquireConnection();
    await connection.executeQuery(raw('insert into t values (1)'));
    await expect(connection.executeQuery(schemaChange('create table t2 (id int)'))).rejects.toThrow(refusal);
    await isolation.rollback();
    expect(sent.map((statement) => statement.sql)).toEqual(['begin', 'insert into t values (1)', 'rollback']);
    expect(sent.map((statement) => statement.control)).toEqual(['begin', undefined, 'rollback']);
  });

  it('marks the rollback that ends a pinned isolation when the driver is destroyed with it open', async () => {
    const { sent, inner } = recording();
    const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', driver: 'mysql', target: 'fake' });
    await driver.isolate();
    await driver.destroy();
    expect(sent.map((statement) => [statement.sql, statement.control])).toEqual([['begin', 'begin'], ['rollback', 'rollback']]);
  });

  it('lets the other drivers run a schema change of the builder inside a transaction: only MySQL commits at one', async () => {
    for (const sqlDriver of ['pgsql', 'sqlite'] as const) {
      const { sent, inner } = recording();
      const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', driver: sqlDriver, target: 'fake' });
      const connection = await driver.acquireConnection();
      await driver.beginTransaction(connection, {});
      await connection.executeQuery(schemaChange('create table inside (id int)'));
      await driver.commitTransaction(connection);
      expect(sent.map((statement) => statement.sql), sqlDriver).toContain('create table inside (id int)');
    }
  });

  it('marks the begin, commit and rollback of its own transactions, and nothing else; the other drivers get none', async () => {
    for (const sqlDriver of ['mysql', 'pgsql'] as const) {
      const { sent, inner } = recording();
      const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', driver: sqlDriver, target: 'fake' });
      const connection = await driver.acquireConnection();
      await driver.beginTransaction(connection, {});
      await connection.executeQuery(raw('commit'));
      await driver.commitTransaction(connection);
      await driver.beginTransaction(connection, {});
      await driver.rollbackTransaction(connection);
      const marks = sent.map((statement) => statement.control);
      expect(marks, sqlDriver).toEqual(sqlDriver === 'mysql' ? ['begin', undefined, 'commit', 'begin', 'rollback'] : [undefined, undefined, undefined, undefined, undefined]);
    }
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

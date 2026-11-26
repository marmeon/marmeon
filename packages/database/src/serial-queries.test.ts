import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { runTransaction } from '@marmeon/core/internal';
import { CompiledQuery, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql, type DatabaseConnection, type Driver, type QueryResult } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TransactionError, TransactionFinishedError } from '@marmeon/core';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { MarmeonDriver, serialQueries, UncheckedDriver } from './driver.ts';
import { InfrastructureDriver } from './infrastructure.ts';
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

/** A hang is a failure, not a stuck suite. */
function within<T>(promise: Promise<T>, ms = 20_000): Promise<T> {
  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`hung for ${ms} ms`)))]);
}

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


  it('asks the admit hook when a query is sent, in the sender’s call chain — a refused query or stream never queues or reaches the connection', async () => {
    const log: string[] = [];
    const inner = new CountingConnection(log);
    const senders = new AsyncLocalStorage<string>();
    const asked: Array<[string, string | undefined]> = [];
    const refusal = new Error('too late');
    const connection = serialQueries(inner, {
      admit: (query) => {
        asked.push([query.sql, senders.getStore()]);
        return query.sql === 'late' ? refusal : undefined;
      },
    });
    const slow = connection.executeQuery(raw('slow 1'));
    const refused = await senders.run('sender', () => connection.executeQuery(raw('late')).then(() => 'ran', (error: unknown) => error));
    expect(refused).toBe(refusal);
    // Refused on the spot: the query ahead of it has not ended, and nothing was queued behind it.
    expect(log).not.toContain('end slow 1');
    const refusedStream = await senders.run('sender', async () => {
      try {
        for await (const _chunk of connection.streamQuery(raw('late'), 1)) void _chunk;
        return 'ran';
      } catch (error) {
        return error;
      }
    });
    expect(refusedStream).toBe(refusal);
    expect(log).not.toContain('end slow 1');
    await slow;
    await connection.executeQuery(raw('after'));
    for await (const _chunk of connection.streamQuery(raw('stream after'), 1)) void _chunk;
    expect(log).not.toContain('start late');
    expect(asked.filter(([text]) => text === 'late').length).toBeGreaterThan(0);
    expect(asked.filter(([text]) => text === 'late').every(([, sender]) => sender === 'sender')).toBe(true);
  });

  describe.each(['execute', 'stream'] as const)('asks admit in every layer of a %s', (kind) => {
    /** `resolve` pends until released; `admit` refuses on the call numbered `refuseOn` only. */
    function setup(refuseOn: 1 | 2) {
      const log: string[] = [];
      const refusal = new Error(`refused on call ${refuseOn}`);
      let calls = 0;
      let resolved = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const connection = serialQueries(new CountingConnection(log), {
        deferred: (query) => query.sql === 'deferred',
        resolve: async (query) => {
          resolved++;
          await gate;
          return query;
        },
        admit: () => (++calls === refuseOn ? refusal : undefined),
      });
      const send = () =>
        kind === 'execute'
          ? connection.executeQuery(raw('deferred')).then(() => 'ran', (error: unknown) => error)
          : (async () => {
              try {
                for await (const _chunk of connection.streamQuery(raw('deferred'), 1)) void _chunk;
                return 'ran';
              } catch (error) {
                return error;
              }
            })();
      return { log, refusal, send, release, resolved: () => resolved };
    }

    it('before the query is resolved — a refusal there never waits for the resolution', async () => {
      const { refusal, send, release, resolved } = setup(1);
      expect(await send()).toBe(refusal);
      expect(resolved()).toBe(0);
      release();
    });

    it('again right before it queues — a refusal after the resolution never reaches the connection', async () => {
      const { log, refusal, send, release, resolved } = setup(2);
      const outcome = send();
      release();
      expect(await outcome).toBe(refusal);
      expect(resolved()).toBe(1);
      expect(log).toEqual([]);
    });
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


  it('seals a connection while the outermost commit is under way and after a failed one — until rollback() — and not after one that succeeded; a savepoint’s release seals nothing', async () => {
    for (const sqlDriver of ['mysql', 'pgsql'] as const) {
      const { sent, inner } = recording();
      let failing = false;
      const base = fakeDriver(inner);
      const driver = new MarmeonDriver(
        { ...base, commitTransaction: async (given) => { await base.commitTransaction(given); if (failing) throw new Error('commit failed'); } },
        { name: 'default', driver: sqlDriver, target: 'fake' },
      );
      const connection = await driver.acquireConnection();
      await driver.beginTransaction(connection, {});
      await driver.beginTransaction(connection, {});
      await driver.commitTransaction(connection);
      await connection.executeQuery(raw('insert after the release'));
      // A statement sent while the commit is under way: refused, the commit itself goes out.
      const committing = driver.commitTransaction(connection);
      await expect(connection.executeQuery(raw('insert during the commit')), sqlDriver).rejects.toBeInstanceOf(TransactionError);
      await committing;
      // The commit succeeded: no frame names the transaction and Kysely has its own flag, so a statement is a plain one again.
      await connection.executeQuery(raw('insert after the commit'));
      await driver.beginTransaction(connection, {});
      failing = true;
      await expect(driver.commitTransaction(connection)).rejects.toThrow('commit failed');
      failing = false;
      await expect(connection.executeQuery(raw('insert after the failed commit')), sqlDriver).rejects.toBeInstanceOf(TransactionError);
      // Kysely rolls back next, which is what lifts it.
      await driver.rollbackTransaction(connection);
      await connection.executeQuery(raw('insert after the rollback'));
      expect(sent.map((statement) => statement.sql), sqlDriver).toEqual([
        'begin', 'savepoint marmeon_savepoint_1', 'release savepoint marmeon_savepoint_1', 'insert after the release', 'commit',
        'insert after the commit', 'begin', 'commit', 'rollback', 'insert after the rollback',
      ]);
    }
  });

  it('refuses the handle of a transaction whose rollback failed for good — also after the pool handed the connection out again, to a fresh handle', async () => {
    const { sent, inner } = recording();
    const base = fakeDriver(inner);
    const driver = new MarmeonDriver(
      { ...base, rollbackTransaction: async (given) => { await base.rollbackTransaction(given); throw new Error('rollback failed'); } },
      { name: 'default', driver: 'pgsql', target: 'fake' },
    );
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await expect(driver.rollbackTransaction(connection)).rejects.toThrow('rollback failed');
    await expect(connection.executeQuery(raw('insert after the failed rollback'))).rejects.toBeInstanceOf(TransactionError);
    await driver.releaseConnection(connection);
    await expect(connection.executeQuery(raw('insert between release and acquire'))).rejects.toBeInstanceOf(TransactionError);
    const again = await driver.acquireConnection();
    expect(again).not.toBe(connection);
    await again.executeQuery(raw('insert after the release'));
    await expect(connection.executeQuery(raw('insert through the dead handle'))).rejects.toBeInstanceOf(TransactionError);
    expect(sent.map((statement) => statement.sql)).toEqual(['begin', 'rollback', 'insert after the release']);
  });

  it('runs the statements after a data step’s transaction on the connection a migration reserved, on MySQL: nothing is refused', async () => {
    const { sent, inner } = recording();
    const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', driver: 'mysql', target: 'fake' });
    const reserved = await driver.acquireConnection();
    await reserved.executeQuery(raw('create table ledger (id int)'));
    await driver.beginTransaction(reserved, {});
    await reserved.executeQuery(raw('insert into ledger values (1)'));
    await driver.commitTransaction(reserved);
    await reserved.executeQuery(raw('alter table ledger add column note text'));
    await driver.beginTransaction(reserved, {});
    await reserved.executeQuery(raw('update ledger set id = 2'));
    await driver.commitTransaction(reserved);
    await reserved.executeQuery(raw('select * from ledger'));
    expect(sent.map((statement) => statement.sql)).toEqual([
      'create table ledger (id int)', 'begin', 'insert into ledger values (1)', 'commit', 'alter table ledger add column note text',
      'begin', 'update ledger set id = 2', 'commit', 'select * from ledger',
    ]);
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

// Work that arrives after a transaction ended, at every tick of the window after its commit, on a dialect that counts what it hands out and takes back.
describe('work that arrives after the commit of a transaction, tick by tick', () => {
  const settle = (work: Promise<unknown>) => work.then(() => 'ran', (error: unknown) => error);

  async function sweep(ticks: number) {
    const log: string[] = [];
    const inner = new CountingConnection(log);
    let acquired = 0;
    let released = 0;
    const base = fakeDriver(inner);
    const driver = new MarmeonDriver(
      { ...base, acquireConnection: async () => (acquired++, inner), releaseConnection: async () => void released++ },
      { name: 'default', driver: 'pgsql', target: 'fake' },
    );
    let late: Promise<unknown[]> | undefined;
    const db: Kysely<any> = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => driver,
        createIntrospector: (kysely) => new PostgresIntrospector(kysely),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      // Started where the commit was awaited: in the transaction's call chain.
      log: (event) => {
        if (event.level === 'query' && event.query.sql === 'commit' && !late) late = start();
      },
    });
    const transaction = (title: string) => runTransaction(driver, 'default', () => db.transaction().execute((trx) => trx.insertInto('t').values({ title }).execute()));
    const start = async () => {
      for (let tick = 0; tick < ticks; tick++) await new Promise((resolve) => setImmediate(resolve));
      return [await settle(transaction('late, nested')), await settle(db.insertInto('t').values({ title: 'late, plain' }).execute())];
    };
    await transaction('first');
    const results = await late;
    await db.destroy();
    return { log, results, acquired, released };
  }

  it('refuses a nested transaction() and a plain query started in the call chain of the commit, at every tick — never sent, never released twice', async () => {
    for (let ticks = 0; ticks <= 30; ticks++) {
      const { log, results, acquired, released } = await within(sweep(ticks));
      for (const result of results ?? []) expect(result, `after ${ticks} ticks`).toBeInstanceOf(TransactionError);
      const afterCommit = log.slice(log.indexOf('start commit'));
      expect(
        afterCommit.filter((entry) => /^start (insert|begin|savepoint)/.test(entry)),
        `after ${ticks} ticks`,
      ).toEqual([]);
      expect(released, `after ${ticks} ticks`).toBe(acquired);
    }
  });
});

describe('a query that took the transaction’s connection before the transaction ended', () => {
  it('holds the connection from the moment it asks for it: the metadata load resumes after the transaction released it, and its own release is not a second one', async () => {
    let acquired = 0;
    let released = 0;
    let waiting = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const inner = new CountingConnection([]);
    const base = fakeDriver(inner);
    const driver = new MarmeonDriver(
      { ...base, acquireConnection: async () => (acquired++, inner), releaseConnection: async () => void released++ },
      // The metadata load of a connection handed out, held up while a query is on its way.
      { name: 'default', driver: 'pgsql', target: 'fake', metadata: { managed: true, refresh: async () => void (waiting && (await gate)), release() {}, holds: () => false, invalidate() {} } as never },
    );
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => driver,
        createIntrospector: (kysely) => new PostgresIntrospector(kysely),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    let late!: Promise<unknown>;
    await runTransaction(driver, 'default', () =>
      db.transaction().execute(async (trx) => {
        await trx.insertInto('t').values({ title: 'inside' }).execute();
        waiting = true;
        late = db.insertInto('t').values({ title: 'late' }).execute().then(() => 'ran', (error: unknown) => error);
      }),
    );
    // The transaction committed and released its connection while the query still waits for the metadata.
    open();
    expect(await late).toBeInstanceOf(TransactionFinishedError);
    await db.destroy();
    expect(released).toBe(acquired);
  });
});

describe('a nested transaction that began before its parent ended', () => {
  it('is refused when its metadata wait ends after the parent committed: it never runs as a transaction of its own, and releases the connection once', async () => {
    const log: string[] = [];
    let released = 0;
    let waiting = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const inner = new CountingConnection(log);
    const base = fakeDriver(inner);
    const driver = new MarmeonDriver(
      { ...base, releaseConnection: async () => void released++ },
      { name: 'default', driver: 'pgsql', target: 'fake', metadata: { managed: true, refresh: async () => void (waiting && (await gate)), release() {}, holds: () => false, invalidate() {} } as never },
    );
    const { late: nested } = await runTransaction(driver, 'default', async () => {
      const connection = await driver.acquireConnection();
      await driver.beginTransaction(connection, {});
      waiting = true;
      // Starts its acquisition inside the transaction and waits for the metadata.
      const late = runTransaction(driver, 'default', async () => {
        const own = await driver.acquireConnection();
        await driver.beginTransaction(own, {});
        await own.executeQuery(raw('insert late nested'));
        await driver.commitTransaction(own);
      }).then(() => 'ran', (error: unknown) => error);
      await connection.executeQuery(raw('insert outer'));
      await driver.commitTransaction(connection);
      await driver.releaseConnection(connection);
      return { late };
    });
    // The outer transaction committed, lifted its seal and released; now the wait ends.
    open();
    expect(await nested).toBeInstanceOf(TransactionFinishedError);
    expect(log.filter((entry) => entry.startsWith('start '))).toEqual(['start begin', 'start insert outer', 'start commit']);
    expect(released).toBe(1);
  });
});

describe('what a transaction counts as its own', () => {
  it('counts only acquisitions routed through its frame: an unchecked connection acquired and released inside it changes nothing, so a late write is still refused', async () => {
    const inner = new CountingConnection([]);
    const other = new CountingConnection([]);
    let handedOut = 0;
    // The unchecked connection is a connection of its own, not the transaction's.
    const driver = new MarmeonDriver({ ...fakeDriver(inner), acquireConnection: async () => (handedOut++ === 0 ? inner : other) }, { name: 'default', driver: 'pgsql', target: 'fake' });
    const unchecked = new UncheckedDriver(driver);
    const late = await runTransaction(driver, 'default', async () => {
      const connection = await driver.acquireConnection();
      await driver.beginTransaction(connection, {});
      await unchecked.releaseConnection(await unchecked.acquireConnection());
      await connection.executeQuery(raw('insert inside'));
      await driver.commitTransaction(connection);
      // The commit succeeded, so only the frame can tell this write from a plain one.
      return connection.executeQuery(raw('insert late')).then(() => 'ran', (error: unknown) => error);
    });
    expect(late).toBeInstanceOf(TransactionFinishedError);
  });

  it('counts only acquisitions routed through its frame: an infrastructure connection acquired and released in the call chain of a finished transaction changes nothing', async () => {
    const inner = new CountingConnection([]);
    const driver = new MarmeonDriver(fakeDriver(inner), { name: 'default', driver: 'pgsql', target: 'fake' });
    const infra = new InfrastructureDriver({ main: driver, peers: () => [driver] });
    const { chain, outstanding } = await runTransaction(driver, 'default', async () => {
      const connection = await driver.acquireConnection();
      await driver.beginTransaction(connection, {});
      // A query that already took the transaction's connection and keeps it: the frame's count stays above zero.
      const outstanding = await driver.acquireConnection();
      await connection.executeQuery(raw('insert inside'));
      await driver.commitTransaction(connection);
      // The transaction's own release: exactly one acquisition of the frame is left.
      await driver.releaseConnection(connection);
      return { chain: AsyncLocalStorage.snapshot(), outstanding };
    });
    const late = await chain(async () => {
      await infra.releaseConnection(await infra.acquireConnection());
      return outstanding.executeQuery(raw('insert late')).then(() => 'ran', (error: unknown) => error);
    });
    expect(late).toBeInstanceOf(TransactionFinishedError);
  });

  it('walks past a transaction of another connection when it looks for an ended savepoint around a late transaction', async () => {
    const fake = () => new MarmeonDriver(fakeDriver(new CountingConnection([])), { name: 'default', driver: 'pgsql', target: 'fake' });
    const first = fake();
    const second = fake();
    const late = await runTransaction(first, 'first', async () => {
      const outer = await first.acquireConnection();
      await first.beginTransaction(outer, {});
      return runTransaction(first, 'first', async () => {
        const savepoint = await first.acquireConnection();
        await first.beginTransaction(savepoint, {});
        return runTransaction(second, 'second', async () => {
          const other = await second.acquireConnection();
          await second.beginTransaction(other, {});
          // The savepoint ended on the driver's side while its transaction is still open in the call chain.
          await first.rollbackTransaction(savepoint);
          const outcome = await runTransaction(first, 'first', () => first.acquireConnection()).then(() => 'ran', (error: unknown) => error);
          await second.commitTransaction(other);
          return outcome;
        });
      });
    });
    expect(late).toBeInstanceOf(TransactionFinishedError);
  });
});

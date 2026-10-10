import { setTimeout as sleep } from 'node:timers/promises';
import { Clock, createApplication, inTransaction, Logger, TestClock, TransactionError, type Application } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql, TransactionFinishedError } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionOptions, databaseConnections, databaseKinds, freshTarget, silent, type QueueTarget } from './__fixtures__/targets.ts';
import { MemoryQueueDriver } from './drivers/memory.ts';
import { QueueFake } from './fake.ts';
import { Queue, QueueManager, QueueServiceProvider, type JobPayload } from './index.ts';
import { QueueConnections } from './connections.ts';
import { JobRegistry } from './registry.ts';
import { JobRunner } from './runner.ts';

// Dispatching inside `connections.transaction()`: the database queue joins the transaction; every other
// connection holds the job until the outermost commit and drops it on a rollback.

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

class Seen {
  readonly entries: { n: number; found: boolean; inTransaction: boolean }[] = [];
}

/** Looks for the `handled` row its payload names — committed or not, as its own connection sees it. */
class LookJob {
  static readonly job = 'test.look';
  static readonly schema = v.object({ n: v.number(), fail: v.optional(v.boolean()) });

  readonly #connections: Connections;
  readonly #seen: Seen;

  constructor(connections: Connections, seen: Seen) {
    this.#connections = connections;
    this.#seen = seen;
  }

  async handle(payload: JobPayload<typeof LookJob>): Promise<void> {
    const { rows } = await sql<{ n: number }>`select n from handled where n = ${payload.n}`.execute(this.#connections.get());
    this.#seen.entries.push({ n: payload.n, found: rows.length > 0, inTransaction: inTransaction() });
    if (payload.fail) throw new Error(`job ${payload.n} failed`);
  }
}

/** Records only whether it runs inside a transaction — no database work of its own. */
class ContextJob {
  static readonly job = 'test.context';
  static readonly schema = v.object({ n: v.number() });

  readonly #seen: Seen;

  constructor(seen: Seen) {
    this.#seen = seen;
  }

  handle(payload: JobPayload<typeof ContextJob>): void {
    this.#seen.entries.push({ n: payload.n, found: false, inTransaction: inTransaction() });
  }
}

class Rollback extends Error {}

describe.each(databaseKinds)('dispatching inside connections.transaction() on %s', (kind) => {
  let target: Exclude<QueueTarget, { kind: 'memory' }>;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const fresh = await freshTarget(kind);
    target = fresh.target as Exclude<QueueTarget, { kind: 'memory' }>;
    drop = fresh.drop;
  });
  afterAll(() => drop());

  async function app(env: Record<string, string> = {}): Promise<Application & { seen: Seen }> {
    const seen = new Seen();
    const database = target.kind === 'sqlite' ? { DB_CONNECTION: 'sqlite', DB_DATABASE: target.file } : { DB_CONNECTION: 'pgsql', DB_URL: target.url };
    const application = await createApplication({
      root: '/tmp',
      discover: false,
      env: { APP_KEY: KEY, ...database, ...env },
      providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider],
      modules: [{ name: 'test', jobs: [LookJob, ContextJob] }],
      override: (container) => {
        container.instance(Clock, new TestClock());
        container.instance(Seen, seen);
        container.instance(Logger, silent);
      },
    });
    const connections = application.container.make(Connections);
    await sql`delete from jobs`.execute(connections.get());
    await sql`delete from handled`.execute(connections.get());
    return Object.assign(application, { seen });
  }

  it('database queue: a job dispatched in the transaction is part of it — gone with a rollback, there with the commit', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    const connections = application.container.make(Connections);
    // Another process's view: its own connection.
    const other = databaseConnections(connectionOptions(target));
    const outside = () => sql<{ count: number | string }>`select count(*) as count from jobs`.execute(other.get()).then(({ rows }) => Number(rows[0]!.count));
    try {
      await expect(
        connections.transaction(async () => {
          await queue.dispatch(LookJob, { n: 1 });
          // Joined: the transaction sees its job (through the queue and through its own db), nobody else does yet.
          expect(await queue.size()).toBe(1);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(await outside()).toBe(0);

      let before = -1;
      await connections.transaction(async () => {
        await queue.dispatch(LookJob, { n: 2 });
        before = await outside();
      });
      expect(before).toBe(0);
      expect(await outside()).toBe(1);
    } finally {
      await other.destroy();
    }
  });

  it('sync queue: the job runs after the commit, outside the transaction, and sees the committed row — never after a rollback', async () => {
    await using application = await app({ QUEUE_CONNECTION: 'sync' });
    const queue = application.container.make(Queue);
    const connections = application.container.make(Connections);
    const db = connections.get();

    await expect(
      connections.transaction(async () => {
        await sql`insert into handled (uuid, n, attempt, pid, event) values ('a', 1, 1, 0, 'x')`.execute(db);
        await queue.dispatch(LookJob, { n: 1 });
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(application.seen.entries).toEqual([]);

    await connections.transaction(async () => {
      await sql`insert into handled (uuid, n, attempt, pid, event) values ('b', 2, 1, 0, 'x')`.execute(db);
      await queue.dispatch(LookJob, { n: 2 });
      expect(application.seen.entries).toEqual([]); // held until the commit
    });
    expect(application.seen.entries).toEqual([{ n: 2, found: true, inTransaction: false }]);

    // Its error comes from transaction() — after the commit, which kept the row.
    await expect(
      connections.transaction(async () => {
        await sql`insert into handled (uuid, n, attempt, pid, event) values ('c', 3, 1, 0, 'x')`.execute(db);
        await queue.dispatch(LookJob, { n: 3, fail: true });
      }),
    ).rejects.toThrow('job 3 failed');
    expect((await sql<{ n: number }>`select n from handled where n = 3`.execute(db)).rows).toHaveLength(1);

    // Outside a transaction: at once.
    await queue.dispatch(LookJob, { n: 2 });
    expect(application.seen.entries).toHaveLength(3);
  });

  it('refuses a dispatch started inside a transaction that runs after it finished', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    let late!: Promise<unknown>;
    await application.container.make(Connections).transaction(async () => {
      late = sleep(20).then(() => queue.dispatch(LookJob, { n: 9 }));
    });
    await expect(late).rejects.toBeInstanceOf(TransactionFinishedError);
    expect(await queue.size()).toBe(0);
  });

  it('holds a job for a queue that cannot join the transaction (redis, another connection) until the commit', async () => {
    await using application = await app();
    const container = application.container;
    // A driver outside the database — like redis: no joinsTransaction().
    const memory = new MemoryQueueDriver({ clock: container.make(Clock) });
    const queue = new QueueManager({
      connections: { outside: { driver: 'database', queue: 'default', connection: 'default', retryAfter: 90 } },
      default: 'outside',
      registry: container.make(JobRegistry),
      driver: () => memory,
      runner: () => new JobRunner(container, container.make(JobRegistry), () => Promise.reject(new Error('no cipher'))),
      cipher: () => Promise.reject(new Error('no cipher')),
      clock: container.make(Clock),
      logger: silent,
    });
    const connections = container.make(Connections);
    await expect(
      connections.transaction(async () => {
        await queue.dispatch(LookJob, { n: 1 });
        expect(await memory.size('default')).toBe(0);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await memory.size('default')).toBe(0);
    await connections.transaction(async () => {
      await queue.dispatch(LookJob, { n: 2 });
      expect(await memory.size('default')).toBe(0);
    });
    expect(await memory.size('default')).toBe(1);
  });

  it('QueueFake: records a job dispatched in a transaction with its commit, not after a rollback', async () => {
    await using application = await app();
    const fake = new QueueFake(application.container);
    const connections = application.container.make(Connections);
    await connections
      .transaction(async () => {
        await fake.dispatch(LookJob, { n: 1 });
        throw new Rollback();
      })
      .catch(() => {});
    fake.assertNothingDispatched();
    await connections.transaction(() => fake.dispatch(LookJob, { n: 2 }));
    expect(fake.dispatched(LookJob)).toMatchObject([{ payload: { n: 2 }, inTransaction: true }]);
  });

  it('runs a job outside the transaction of whoever runs it (the job scope is a boundary)', async () => {
    await using application = await app();
    const container = application.container;
    const runner = new JobRunner(container, container.make(JobRegistry), () => Promise.reject(new Error('no cipher')));
    const prepared = await runner.prepare(JSON.stringify({ uuid: 'u', job: 'test.context', data: { n: 1 }, tries: 1, backoff: [], dispatchedAt: 0 }));
    if (prepared.kind !== 'ready') throw new Error(prepared.kind);
    await container.make(Connections).transaction(() => runner.run(prepared, { attempt: 1, queue: 'default', connection: 'test', signal: new AbortController().signal }));
    expect(application.seen.entries).toEqual([{ n: 1, found: false, inTransaction: false }]);
  });

  it('works the queue outside the transaction of whoever starts the worker — its acks survive a rollback there', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    const connections = application.container.make(Connections);
    await queue.dispatch(ContextJob, { n: 1 });
    const worker = application.container.make(QueueConnections).worker('database', 10);
    const run = connections.transaction(async () => {
      await worker.run({ queues: ['default'], stopWhenEmpty: true });
      throw new Rollback();
    });
    if (kind === 'sqlite') {
      // One physical connection, held by the transaction: the worker cannot claim outside of it — it says so at once.
      await expect(run).rejects.toBeInstanceOf(TransactionError);
      expect(await queue.size()).toBe(1);
    } else {
      await expect(run).rejects.toBeInstanceOf(Rollback);
      expect(application.seen.entries).toEqual([{ n: 1, found: false, inTransaction: false }]);
      expect(await queue.size()).toBe(0); // acked on its own connection, not undone with the transaction
    }
  });
});

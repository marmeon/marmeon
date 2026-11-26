import { setTimeout as sleep } from 'node:timers/promises';
import { Clock, createApplication, inTransaction, Logger, TransactionError, type Application } from '@marmeon/core';
import { Cache, CacheServiceProvider } from '@marmeon/cache';
import { TestClock } from '@marmeon/core/testing';
import { Connections, DatabaseServiceProvider, sql, TransactionFinishedError } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionOptions, databaseConnections, databaseKinds, freshTarget, silent, type QueueTarget } from './__fixtures__/targets.ts';
import { MemoryQueueDriver } from './drivers/memory.ts';
import { QueueFake } from './fake.ts';
import { Queue, QueueServiceProvider, type JobPayload } from './index.ts';
import { QueueManager } from './queue.ts';
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

/** Accepts a payload at the dispatch and refuses it at the run while `refuse.now` is set — a job whose record the runner will not hand out. */
const refuse = { now: false };

class RefusedJob {
  static readonly job = 'test.refused';
  static readonly schema = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (value: unknown) => (refuse.now ? { issues: [{ message: 'refused at the run' }] } : { value: value as { n: number } }),
      types: undefined as unknown as { input: { n: number }; output: { n: number } },
    },
  };

  handle(): void {}
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
    const database = target.kind === 'sqlite' ? { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: target.file } : { DB_MANAGED: 'false', DB_DRIVER: 'pgsql', DB_URL: target.url };
    const application = await createApplication({
      root: '/tmp',
      discover: false,
      providers: [DatabaseServiceProvider, EncryptionServiceProvider, CacheServiceProvider, QueueServiceProvider],
      modules: [{ name: 'test', jobs: [LookJob, ContextJob, RefusedJob] }],
    }, {
      env: { APP_KEY: KEY, NODE_ENV: 'test', CACHE_DRIVER: 'memory', ...database, ...env },
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
    await using application = await app({ QUEUE_DRIVER: 'sync' });
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

  describe('a unique job whose dispatch never gives a job', () => {
    /** A dispatch begun inside a transaction that runs only once `finish()` is called — after the transaction ended. */
    function late(run: () => Promise<unknown>): { readonly result: Promise<unknown>; readonly finish: () => void } {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => (finish = resolve));
      return { result: gate.then(run), finish };
    }

    it('frees the lock of a dispatch refused because its transaction finished, so the key can be dispatched again', async () => {
      await using application = await app();
      const queue = application.container.make(Queue);
      const connections = application.container.make(Connections);
      let held!: ReturnType<typeof late>;
      await connections.transaction(async () => {
        held = late(() => queue.dispatch(ContextJob, { n: 1 }, { unique: 'k' }));
      });
      held.finish();
      await expect(held.result).rejects.toBeInstanceOf(TransactionFinishedError);
      expect(await queue.dispatch(ContextJob, { n: 2 }, { unique: 'k' })).toEqual(expect.any(String));
      expect(await queue.size()).toBe(1);
    });

    it('QueueFake: frees the lock of a dispatch refused because its transaction finished', async () => {
      await using application = await app();
      const fake = new QueueFake(application.container);
      const connections = application.container.make(Connections);
      let held!: ReturnType<typeof late>;
      await connections.transaction(async () => {
        held = late(() => fake.dispatch(ContextJob, { n: 1 }, { unique: 'k' }));
      });
      held.finish();
      await expect(held.result).rejects.toBeInstanceOf(TransactionFinishedError);
      expect(await fake.dispatch(ContextJob, { n: 2 }, { unique: 'k' })).toEqual(expect.any(String));
    });

    it('sync queue: frees the lock when the job is refused at the commit, so the key can be dispatched again', async () => {
      await using application = await app({ QUEUE_DRIVER: 'sync' });
      const queue = application.container.make(Queue);
      const connections = application.container.make(Connections);
      try {
        await expect(
          connections.transaction(async () => {
            await queue.dispatch(RefusedJob, { n: 1 }, { unique: 'k' });
            refuse.now = true;
          }),
        ).rejects.toThrow('refused at the run');
      } finally {
        refuse.now = false;
      }
      expect(await queue.dispatch(RefusedJob, { n: 2 }, { unique: 'k' })).toEqual(expect.any(String));
    });

    it('sync queue: a failed commit frees only the lock its own job took, not a key another dispatch took since', async () => {
      await using application = await app({ QUEUE_DRIVER: 'sync' });
      const queue = application.container.make(Queue);
      const connections = application.container.make(Connections);
      const cache = application.container.make(Cache);
      const taken = cache.lock('queue:unique:test.refused:k', 60);
      try {
        await expect(
          connections.transaction(async () => {
            await queue.dispatch(RefusedJob, { n: 1 }, { unique: 'k' });
            refuse.now = true;
            // The first lock is gone (expired, say) and another dispatch took the key.
            await cache.lock('queue:unique:test.refused:k', 60).forceRelease();
            expect(await taken.get()).toBe(true);
          }),
        ).rejects.toThrow('refused at the run');
      } finally {
        refuse.now = false;
      }
      expect(await queue.dispatch(RefusedJob, { n: 2 }, { unique: 'k' })).toBeUndefined();
      expect(await taken.release()).toBe(true);
    });

    type Locks = Cache['lock'];
    /** The plain form of `Lock.get()`, which the tests replace. */
    type Patchable = { get: () => Promise<boolean> };

    /** Runs `use` with every lock the cache makes passed through `wrap`; the cache's own `lock` is back afterwards. */
    async function wrapping(cache: Cache, wrap: (lock: Patchable, made: number) => void, use: () => Promise<void>): Promise<void> {
      const real = cache.lock.bind(cache);
      let made = 0;
      cache.lock = ((...args: Parameters<Locks>) => {
        const lock = real(...args);
        wrap(lock as unknown as Patchable, made++);
        return lock;
      }) as Locks;
      try {
        await use();
      } finally {
        cache.lock = real;
      }
    }

    /** The first lock takes its key for real, says so through `reached`, then `get()` waits on `gate` before it answers. */
    function holdFirstGet(gate: Promise<void>, reached: () => void): (lock: Patchable, made: number) => void {
      return (lock, made) => {
        if (made > 0) return;
        const get = (lock.get as () => Promise<boolean>).bind(lock);
        lock.get = async () => {
          const taken = await get();
          reached();
          await gate;
          return taken;
        };
      };
    }

    for (const driver of ['database', 'sync'] as const) {
      it(`${driver} queue: never takes the lock of a dispatch that runs after its transaction finished`, async () => {
        await using application = await app({ QUEUE_DRIVER: driver });
        const queue = application.container.make(Queue);
        const connections = application.container.make(Connections);
        let gets = 0;
        let held!: ReturnType<typeof late>;
        await wrapping(application.container.make(Cache), (lock) => {
          const get = (lock.get as () => Promise<boolean>).bind(lock);
          lock.get = () => (gets++, get());
        }, async () => {
          await connections.transaction(async () => {
            held = late(() => queue.dispatch(ContextJob, { n: 1 }, { unique: 'k' }));
          });
          held.finish();
          await expect(held.result).rejects.toBeInstanceOf(TransactionFinishedError);
        });
        expect(gets).toBe(0);
      });

      it(`${driver} queue: frees the lock taken before its transaction finished, when the dispatch is refused after it`, async () => {
        await using application = await app({ QUEUE_DRIVER: driver });
        const queue = application.container.make(Queue);
        const connections = application.container.make(Connections);
        const cache = application.container.make(Cache);
        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        let reached!: () => void;
        const taken = new Promise<void>((resolve) => (reached = resolve));
        let outcome!: Promise<unknown>;
        await wrapping(cache, holdFirstGet(gate, () => reached()), async () => {
          await connections.transaction(async () => {
            outcome = queue.dispatch(RefusedJob, { n: 1 }, { unique: 'k' }).then(() => undefined, (error: unknown) => error);
            await taken; // the lock is held before the transaction ends
          });
          open();
          expect(await outcome).toBeInstanceOf(TransactionFinishedError);
        });
        expect(await cache.lock('queue:unique:test.refused:k', 60).get()).toBe(true);
      });
    }

    it('QueueFake: never takes the lock of a dispatch that runs after its transaction finished', async () => {
      await using application = await app();
      const fake = new QueueFake(application.container);
      const connections = application.container.make(Connections);
      let gets = 0;
      let held!: ReturnType<typeof late>;
      await wrapping(application.container.make(Cache), (lock) => {
        const get = (lock.get as () => Promise<boolean>).bind(lock);
        lock.get = () => (gets++, get());
      }, async () => {
        await connections.transaction(async () => {
          held = late(() => fake.dispatch(ContextJob, { n: 1 }, { unique: 'k' }));
        });
        held.finish();
        await expect(held.result).rejects.toBeInstanceOf(TransactionFinishedError);
      });
      expect(gets).toBe(0);
    });

    it('QueueFake: frees the lock taken before its transaction finished, when the dispatch is refused after it', async () => {
      await using application = await app();
      const fake = new QueueFake(application.container);
      const connections = application.container.make(Connections);
      const cache = application.container.make(Cache);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      let reached!: () => void;
      const taken = new Promise<void>((resolve) => (reached = resolve));
      let outcome!: Promise<unknown>;
      await wrapping(cache, holdFirstGet(gate, () => reached()), async () => {
        await connections.transaction(async () => {
          outcome = fake.dispatch(ContextJob, { n: 1 }, { unique: 'k' }).then(() => undefined, (error: unknown) => error);
          await taken; // the lock is held before the transaction ends
        });
        open();
        expect(await outcome).toBeInstanceOf(TransactionFinishedError);
      });
      expect(await cache.lock('queue:unique:test.context:k', 60).get()).toBe(true);
    });

    it('frees the lock when taking it fails after the cache set it, so the key can be dispatched again', async () => {
      await using application = await app();
      const queue = application.container.make(Queue);
      const cache = application.container.make(Cache);
      await wrapping(cache, (lock, made) => {
        if (made > 0) return;
        const get = (lock.get as () => Promise<boolean>).bind(lock);
        lock.get = async () => {
          await get();
          throw new Error('the reply was lost');
        };
      }, async () => {
        await expect(queue.dispatch(ContextJob, { n: 1 }, { unique: 'k' })).rejects.toThrow('the reply was lost');
      });
      expect(await queue.dispatch(ContextJob, { n: 2 }, { unique: 'k' })).toEqual(expect.any(String));
    });

    it('QueueFake: frees the lock when taking it fails after the cache set it, so the key can be dispatched again', async () => {
      await using application = await app();
      const fake = new QueueFake(application.container);
      const cache = application.container.make(Cache);
      await wrapping(cache, (lock, made) => {
        if (made > 0) return;
        const get = (lock.get as () => Promise<boolean>).bind(lock);
        lock.get = async () => {
          await get();
          throw new Error('the reply was lost');
        };
      }, async () => {
        await expect(fake.dispatch(ContextJob, { n: 1 }, { unique: 'k' })).rejects.toThrow('the reply was lost');
      });
      expect(await fake.dispatch(ContextJob, { n: 2 }, { unique: 'k' })).toEqual(expect.any(String));
    });

    it('QueueFake: frees the lock of a dispatch that throws after it, like an invalid delay', async () => {
      await using application = await app();
      const fake = new QueueFake(application.container);
      await expect(fake.dispatch(ContextJob, { n: 1 }, { unique: 'k', delay: -1 })).rejects.toThrow(/delay/i);
      expect(await fake.dispatch(ContextJob, { n: 2 }, { unique: 'k' })).toEqual(expect.any(String));
    });

    it('still turns a duplicate away while the first job is queued', async () => {
      await using application = await app();
      const queue = application.container.make(Queue);
      expect(await queue.dispatch(ContextJob, { n: 1 }, { unique: 'k' })).toEqual(expect.any(String));
      expect(await queue.dispatch(ContextJob, { n: 2 }, { unique: 'k' })).toBeUndefined();
      expect(await queue.size()).toBe(1);
    });
  });

  it('database queue: bulk() in the transaction inserts in one statement, and its jobs are part of it', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    const connections = application.container.make(Connections);
    const inserts: string[] = [];
    connections.onQuery((query) => {
      if (/^insert into "?jobs"?/i.test(query.sql)) inserts.push(query.sql);
    });
    const batch = Array.from({ length: 50 }, (_, n) => [LookJob, { n }] as const);
    await expect(
      connections.transaction(async () => {
        await queue.bulk(batch);
        expect(await queue.size()).toBe(50);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await queue.size()).toBe(0);
    expect(inserts).toHaveLength(1);
    await connections.transaction(() => queue.bulk(batch));
    expect(await queue.size()).toBe(50);
    expect(inserts).toHaveLength(2);
  });

  it('holds the jobs of bulk() for a queue that cannot join the transaction until the commit, and pushes them in one call', async () => {
    await using application = await app();
    const container = application.container;
    class Counting extends MemoryQueueDriver {
      readonly calls: number[] = [];
      override async pushMany(entries: Parameters<MemoryQueueDriver['pushMany']>[0]): Promise<void> {
        this.calls.push(entries.length);
        return super.pushMany(entries);
      }
    }
    const memory = new Counting({ clock: container.make(Clock) });
    const queue = new QueueManager({
      connection: (name) => (name === 'outside' ? { driver: 'database', queue: 'default', connection: 'default', retryAfterSeconds: 90 } : undefined),
      connectionNames: () => ['outside'],
      default: 'outside',
      registry: container.make(JobRegistry),
      driver: () => memory,
      runner: () => new JobRunner(container, container.make(JobRegistry), () => Promise.reject(new Error('no cipher'))),
      cipher: () => Promise.reject(new Error('no cipher')),
      clock: container.make(Clock),
      logger: silent,
    });
    const connections = container.make(Connections);
    const batch = [[LookJob, { n: 1 }], [LookJob, { n: 2 }], [LookJob, { n: 3 }]] as const;
    await expect(
      connections.transaction(async () => {
        await queue.bulk(batch);
        expect(await memory.size('default')).toBe(0);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(memory.calls).toEqual([]);
    await connections.transaction(async () => {
      await queue.bulk(batch);
      expect(await memory.size('default')).toBe(0);
    });
    expect(memory.calls).toEqual([3]);
    expect(await memory.size('default')).toBe(3);
  });

  it('holds a job for a queue that cannot join the transaction (redis, another connection) until the commit', async () => {
    await using application = await app();
    const container = application.container;
    // A driver outside the database — like redis: no joinsTransaction().
    const memory = new MemoryQueueDriver({ clock: container.make(Clock) });
    const queue = new QueueManager({
      connection: (name) => (name === 'outside' ? { driver: 'database', queue: 'default', connection: 'default', retryAfterSeconds: 90 } : undefined),
      connectionNames: () => ['outside'],
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
    const prepared = await runner.prepare(JSON.stringify({ v: 1, uuid: 'u', job: 'test.context', data: { n: 1 }, tries: 1, backoff: [], dispatchedAt: 0 }));
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

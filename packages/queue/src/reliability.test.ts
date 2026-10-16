import { setTimeout as sleep } from 'node:timers/promises';
import { Cache, CacheServiceProvider } from '@marmeon/cache';
import { Clock, createApplication, EventRegistry, listen, Logger, type Application } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, DatabaseServiceProvider, InfrastructureTransactionError } from '@marmeon/database';
import { RedisServiceProvider } from '@marmeon/redis';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { connectionOptions, databaseConnections, freshTarget, openDriver, PGSQL_URL, processKinds, REDIS_URL, silent, targetEnv, type SharedTarget } from './__fixtures__/targets.ts';
import { QueueConnections } from './connections.ts';
import { QueueFake } from './fake.ts';
import {
  JobEvent,
  JobFailed,
  JobProcessed,
  JobProcessing,
  JobQueued,
  JobReleased,
  Queue,
  QueueServiceProvider,
  withoutOverlapping,
  type JobContext,
  type JobPayload,
} from './index.ts';

// Unique jobs, chains, job.once, withoutOverlapping and job events — on every driver that
// keeps jobs (database on SQLite and Postgres, redis), with the cache the app would use there.

class Seen {
  readonly entries: { n: number; attempt: number; note?: string }[] = [];
  readonly events: JobEvent[] = [];
  mails = 0;
}

class Rollback extends Error {}

/** Records itself; can fail, discard itself, or dispatch itself again with a unique key (to see whether the key is free). */
class NoteJob {
  static readonly job = 'test.note';
  static readonly schema = v.object({ n: v.number(), fail: v.optional(v.boolean()), discard: v.optional(v.boolean()), again: v.optional(v.picklist(['processing', 'done'])) });
  static readonly tries = 2;

  readonly #seen: Seen;
  readonly #queue: Queue;

  constructor(seen: Seen, queue: Queue) {
    this.#seen = seen;
    this.#queue = queue;
  }

  async handle(payload: JobPayload<typeof NoteJob>, job: JobContext): Promise<void> {
    let note: string | undefined;
    if (payload.again) {
      const id = await this.#queue.dispatch(NoteJob, { n: payload.n + 1 }, { unique: 'again', uniqueUntil: payload.again });
      note = id === undefined ? 'key taken' : 'key free';
    }
    this.#seen.entries.push({ n: payload.n, attempt: job.attempt, ...(note ? { note } : {}) });
    if (payload.fail) throw new Error(`note ${payload.n} failed`);
    if (payload.discard) job.discard('nothing to do');
  }
}

/** Sends a "mail" — through job.once or not — and fails its first attempt after it (a crash before the ack). */
class MailJob {
  static readonly job = 'test.mail';
  static readonly schema = v.object({ n: v.number(), once: v.boolean() });
  static readonly tries = 3;

  readonly #seen: Seen;

  constructor(seen: Seen) {
    this.#seen = seen;
  }

  async handle(payload: JobPayload<typeof MailJob>, job: JobContext): Promise<void> {
    const send = () => {
      this.#seen.mails++;
    };
    if (payload.once) await job.once(`test-mail:${payload.n}`, send);
    else send();
    if (job.attempt === 1) throw new Error('the worker died after the mail');
  }
}

/** Sends a "mail" through job.once — with the default of one try. */
class OnceJob {
  static readonly job = 'test.once';
  static readonly schema = v.object({ n: v.number() });

  readonly #seen: Seen;

  constructor(seen: Seen) {
    this.#seen = seen;
  }

  async handle(payload: JobPayload<typeof OnceJob>, job: JobContext): Promise<void> {
    await job.once(`test-once:${payload.n}`, () => {
      this.#seen.mails++;
      this.#seen.entries.push({ n: payload.n, attempt: job.attempt, note: 'sent' });
    });
  }
}

/** Guarded by withoutOverlapping on its key. */
class GuardedJob {
  static readonly job = 'test.guarded';
  static readonly schema = v.object({ key: v.string() });
  static readonly tries = 3;
  static readonly middleware = [withoutOverlapping<typeof GuardedJob>((payload) => payload.key, { releaseAfter: 30 })];

  readonly #seen: Seen;

  constructor(seen: Seen) {
    this.#seen = seen;
  }

  handle(_payload: JobPayload<typeof GuardedJob>, job: JobContext): void {
    this.#seen.entries.push({ n: 0, attempt: job.attempt, note: 'ran' });
  }
}

/** Records every job event. */
class RecordJobEvents {
  readonly #seen: Seen;

  constructor(seen: Seen) {
    this.#seen = seen;
  }

  handle(event: JobEvent): void {
    this.#seen.events.push(event);
  }
}

type TestApp = Application & { seen: Seen; queue: Queue; target: SharedTarget; clock: TestClock; work(queues?: string[] | 'every queue'): Promise<void> };

/** The cache a target's app would use for the queue's locks: memory beside SQLite (a shared file cannot lock inside a transaction). */
function cacheFor(target: SharedTarget): Record<string, string> {
  return { CACHE_DRIVER: target.kind === 'sqlite' ? 'memory' : target.kind === 'pgsql' ? 'database' : 'redis' };
}

async function withApp(kind: SharedTarget['kind'], test: (app: TestApp) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const { target: fresh, drop } = await freshTarget(kind);
  const target = fresh as SharedTarget;
  const seen = new Seen();
  const clock = new TestClock();
  const application = await createApplication({
    root: '/tmp',
    discover: false,
    env: { ...targetEnv(target), ...cacheFor(target), ...env },
    providers: [DatabaseServiceProvider, RedisServiceProvider, CacheServiceProvider, QueueServiceProvider],
    modules: [{ name: 'test', jobs: [NoteJob, MailJob, OnceJob, GuardedJob], listeners: [listen(JobEvent, RecordJobEvents)] }],
    override: (container) => {
      container.instance(Seen, seen);
      container.instance(Logger, silent);
      container.instance(Clock, clock);
    },
  });
  const connection = application.container.make(QueueConnections).default;
  const app = Object.assign(application, {
    seen,
    target,
    clock,
    queue: application.container.make(Queue),
    work: async (queues: string[] | 'every queue' = ['default']) => {
      await application.container.make(QueueConnections).worker(connection, 1).run({ ...(queues === 'every queue' ? {} : { queues }), stopWhenEmpty: true, stopTimeout: 1 });
    },
  });
  try {
    await test(app);
  } finally {
    await application.shutdown();
    await drop();
  }
}

describe.each(processKinds)('unique jobs on %s', (kind) => {
  it('queues a second job with the same key not at all until the first is done — then again', async () => {
    await withApp(kind, async (app) => {
      const first = await app.queue.dispatch(NoteJob, { n: 1 }, { unique: 'report' });
      expect(first).toEqual(expect.any(String));
      expect(await app.queue.dispatch(NoteJob, { n: 2 }, { unique: 'report' })).toBeUndefined();
      // Another key, another job class's same key, a dispatch without a key: all queued.
      expect(await app.queue.dispatch(NoteJob, { n: 3 }, { unique: 'other' })).toEqual(expect.any(String));
      expect(await app.queue.dispatch(NoteJob, { n: 4 })).toEqual(expect.any(String));
      expect(await app.queue.size()).toBe(3);
      await app.work();
      expect(app.seen.entries.map((entry) => entry.n)).toEqual([1, 3, 4]);
      expect(await app.queue.dispatch(NoteJob, { n: 5 }, { unique: 'report' })).toEqual(expect.any(String));
    });
  });

  it("frees the key when the job starts with uniqueUntil: 'processing' — and only when it is done by default", async () => {
    await withApp(kind, async (app) => {
      await app.queue.dispatch(NoteJob, { n: 1, again: 'processing' }, { unique: 'again', uniqueUntil: 'processing' });
      await app.queue.dispatch(NoteJob, { n: 10, again: 'done' }, { unique: 'other' });
      await app.queue.dispatch(NoteJob, { n: 20 }, { unique: 'again-done' });
      await app.work();
      // n 1 ran with its key freed: the dispatch from inside it was queued (n 2, which ran too).
      expect(app.seen.entries.find((entry) => entry.n === 1)?.note).toBe('key free');
      expect(app.seen.entries.map((entry) => entry.n)).toContain(2);
    });
    await withApp(kind, async (app) => {
      await app.queue.dispatch(NoteJob, { n: 1, again: 'done' }, { unique: 'again' });
      await app.work();
      // Unique until done: while it runs, its own key is still taken.
      expect(app.seen.entries).toEqual([{ n: 1, attempt: 1, note: 'key taken' }]);
      expect(await app.queue.dispatch(NoteJob, { n: 3 }, { unique: 'again' })).toEqual(expect.any(String));
    });
  });

  it('frees the key of a job that failed for good, and keeps it while the job retries', async () => {
    await withApp(kind, async (app) => {
      await app.queue.dispatch(NoteJob, { n: 1, fail: true }, { unique: 'report' });
      await app.container.make(QueueConnections).worker(app.container.make(QueueConnections).default, 1).run({ queues: ['default'], stopWhenEmpty: true, maxJobs: 1 });
      // Attempt 1 failed, the job waits for its retry: still unique.
      expect(await app.queue.dispatch(NoteJob, { n: 2 }, { unique: 'report' })).toBeUndefined();
      await app.work();
      expect(app.seen.entries.map((entry) => entry.attempt)).toEqual([1, 2]);
      expect(await app.queue.dispatch(NoteJob, { n: 3 }, { unique: 'report' })).toEqual(expect.any(String));
    });
  });

  it('frees the key after uniqueFor even when the job never ran', async () => {
    await withApp(kind, async (app) => {
      expect(await app.queue.dispatch(NoteJob, { n: 1 }, { unique: 'report', uniqueFor: 1 })).toEqual(expect.any(String));
      expect(await app.queue.dispatch(NoteJob, { n: 2 }, { unique: 'report', uniqueFor: 1 })).toBeUndefined();
      // Memory and database locks follow the app's clock; Redis keeps its own time.
      if (kind === 'redis') await sleep(1100);
      else app.clock.travel({ seconds: 1 });
      expect(await app.queue.dispatch(NoteJob, { n: 3 }, { unique: 'report', uniqueFor: 1 })).toEqual(expect.any(String));
    });
  });

  it('frees the key when the transaction around the dispatch rolls back (also a savepoint) — a later dispatch is queued', async () => {
    await withApp(kind, async (app) => {
      const connections = app.container.make(Connections);
      await expect(
        connections.transaction(async () => {
          expect(await app.queue.dispatch(NoteJob, { n: 1 }, { unique: 'report' })).toEqual(expect.any(String));
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(await app.queue.size()).toBe(0);
      expect(await app.queue.dispatch(NoteJob, { n: 2 }, { unique: 'report' })).toEqual(expect.any(String));
      await app.work();

      // A savepoint that rolls back frees the key at once: dispatching again in the same outer transaction works.
      await connections.transaction(async () => {
        await connections
          .transaction(async () => {
            await app.queue.dispatch(NoteJob, { n: 3 }, { unique: 'nested' });
            throw new Rollback();
          })
          .catch(() => {});
        expect(await app.queue.dispatch(NoteJob, { n: 4 }, { unique: 'nested' })).toEqual(expect.any(String));
      });
      await app.work();
      expect(app.seen.entries.map((entry) => entry.n)).toEqual([2, 4]);
    });
  });
});

describe.each(processKinds)('dispatching inside connections.transaction() on %s', (kind) => {
  it('queues nothing when the transaction rolls back, and one job with the commit — as another process sees it', async () => {
    await withApp(kind, async (app) => {
      const connections = app.container.make(Connections);
      // Another process's view of the queue: its own connections.
      const others = databaseConnections(connectionOptions(app.target));
      const other = openDriver(app.target, others);
      try {
        await expect(
          connections.transaction(async () => {
            await app.queue.dispatch(NoteJob, { n: 1 });
            throw new Rollback();
          }),
        ).rejects.toBeInstanceOf(Rollback);
        expect(await other.driver.size('default')).toBe(0);
        let during = -1;
        await connections.transaction(async () => {
          await app.queue.dispatch(NoteJob, { n: 2 });
          during = await other.driver.size('default');
        });
        // Redis holds the push until the commit; the database queue writes into the transaction (invisible outside).
        expect(during).toBe(0);
        expect(await other.driver.size('default')).toBe(1);
      } finally {
        await other.close();
        await others.destroy();
      }
    });
  });
});

describe.each(processKinds)('chains on %s', (kind) => {
  it('runs the jobs of a chain one after the other — the next queued only with the success of the one before', async () => {
    await withApp(kind, async (app) => {
      const ids = await app.queue.chain([
        [NoteJob, { n: 1 }],
        [NoteJob, { n: 2 }],
        [NoteJob, { n: 3 }],
      ]);
      expect(new Set(ids).size).toBe(3);
      // Only the first waits in the queue; the rest travels in its record.
      expect(await app.queue.size()).toBe(1);
      await app.work();
      expect(app.seen.entries.map((entry) => entry.n)).toEqual([1, 2, 3]);
      expect(await app.queue.size()).toBe(0);
      // Each job of the chain kept the id chain() returned for it.
      expect(app.seen.events.filter((event) => event instanceof JobProcessed).map((event) => event.jobId)).toEqual(ids);
    });
  });

  it('never runs the rest of a chain after a job failed for good (or discarded itself)', async () => {
    await withApp(kind, async (app) => {
      await app.queue.chain([
        [NoteJob, { n: 1 }],
        [NoteJob, { n: 2, fail: true }],
        [NoteJob, { n: 3 }],
      ]);
      await app.queue.chain([
        [NoteJob, { n: 10, discard: true }],
        [NoteJob, { n: 11 }],
      ]);
      await app.work();
      expect(app.seen.entries.map((entry) => `${entry.n}:${entry.attempt}`).sort()).toEqual(['10:1', '1:1', '2:1', '2:2']);
      expect(app.seen.events.filter((event) => event instanceof JobFailed).map((event) => event.job)).toEqual(['test.note']);
      expect(await app.queue.size()).toBe(0);
    });
  });

  it('checks every payload of a chain when it is dispatched — a bad one queues none', async () => {
    await withApp(kind, async (app) => {
      await expect(app.queue.chain([[NoteJob, { n: 1 }], [NoteJob, { n: 'x' } as never]])).rejects.toThrow(/does not match its schema: n:/);
      expect(await app.queue.size()).toBe(0);
    });
  });
});

describe.each(processKinds)('job.once, withoutOverlapping and job events on %s', (kind) => {
  it('runs a job.once side effect once although the attempt after it failed (twice without job.once)', async () => {
    await withApp(kind, async (app) => {
      await app.queue.dispatch(MailJob, { n: 1, once: true });
      await app.work();
      expect(app.seen.mails).toBe(1);
      await app.queue.dispatch(MailJob, { n: 2, once: false });
      await app.work();
      expect(app.seen.mails).toBe(3);
      // The marker is in the app's cache, per key: another job with the key skips it as well.
      await app.queue.dispatch(MailJob, { n: 1, once: true });
      await app.work();
      expect(app.seen.mails).toBe(3);
    });
  });

  it('job.once on a key another attempt runs right now: released without using up a try — it runs once the key is free', async () => {
    await withApp(kind, async (app) => {
      // Another attempt is sending this mail right now (a claim that expired while its worker still ran).
      const held = app.container.make(Cache).lock('queue:once-lock:test-once:1', 60);
      expect(await held.get()).toBe(true);
      await app.queue.dispatch(OnceJob, { n: 1 });
      await app.work();
      const outcome = (event: JobEvent) => `${event.constructor.name}:${JSON.stringify({ attempt: (event as JobReleased).attempt, reason: (event as JobReleased).reason, delay: (event as JobReleased).delay })}`;
      const after = app.seen.events.filter((event) => event instanceof JobReleased || event instanceof JobFailed).map(outcome);
      // With one try, a failed attempt would be the end: the job is released instead, and the attempt is given back.
      expect(after, JSON.stringify(after)).toEqual(['JobReleased:{"attempt":1,"reason":"busy","delay":5}']);
      expect(app.seen.mails).toBe(0);
      expect(await app.queue.size()).toBe(1);
      await held.release();
      app.clock.travel({ seconds: 5 });
      await app.work();
      // Its try is still there: attempt 1 again, the mail sent once, nothing failed.
      const failed = app.seen.events.flatMap((event) => (event instanceof JobFailed ? [event.error.message] : []));
      expect(failed, JSON.stringify(failed)).toEqual([]);
      expect(app.seen.entries).toEqual([{ n: 1, attempt: 1, note: 'sent' }]);
      expect(await app.queue.size()).toBe(0);
    });
  });

  it('withoutOverlapping: releases an attempt while another holds the key, runs it once the key is free', async () => {
    await withApp(kind, async (app) => {
      const held = app.container.make(Cache).lock('queue:overlap:test.guarded:report', 60);
      expect(await held.get()).toBe(true);
      await app.queue.dispatch(GuardedJob, { key: 'report' });
      await app.work();
      expect(app.seen.entries).toEqual([]);
      expect(app.seen.events.find((event) => event instanceof JobReleased)).toMatchObject({ reason: 'job', delay: 30, attempt: 1 });
      await held.release();
      // The release delay follows the queue's clock (on Redis too: its scores are the app's time).
      app.clock.travel({ seconds: 30 });
      await app.work();
      expect(app.seen.entries).toEqual([{ n: 0, attempt: 2, note: 'ran' }]);
      // The lock is free again after the run.
      expect(await app.container.make(Cache).lock('queue:overlap:test.guarded:report', 60).get()).toBe(true);
    });
  });

  it('dispatches JobQueued, JobProcessing, JobProcessed, JobReleased and JobFailed through the event dispatcher', async () => {
    await withApp(kind, async (app) => {
      const id = await app.queue.dispatch(NoteJob, { n: 1, fail: true });
      await app.work();
      const connection = app.container.make(QueueConnections).default;
      const summary = app.seen.events.map((event) => `${event.constructor.name}:${event.jobId === id}:${event.connection === connection}:${event.queue}`);
      expect(summary).toEqual([
        'JobQueued:true:true:default',
        'JobProcessing:true:true:default',
        'JobReleased:true:true:default',
        'JobProcessing:true:true:default',
        'JobFailed:true:true:default',
      ]);
      expect(app.seen.events[2]).toMatchObject({ reason: 'error', attempt: 1, delay: 0, ms: expect.any(Number) });
      expect((app.seen.events[4] as JobFailed).error.message).toBe('note 1 failed');
      expect(app.seen.events[0]).toBeInstanceOf(JobQueued);
      expect(app.seen.events[1]).toBeInstanceOf(JobProcessing);
    });
  });

  it('a listener of a job event that throws is logged — the job runs and is acknowledged all the same', async () => {
    await withApp(kind, async (app) => {
      app.container.make(EventRegistry).listen(JobProcessing, () => {
        throw new Error('the dashboard is down');
      });
      await app.queue.dispatch(NoteJob, { n: 1 });
      await app.work();
      expect(app.seen.entries.map((entry) => entry.n)).toEqual([1]);
      expect(await app.queue.size()).toBe(0);
      // The dispatcher stops at the failing listener (core: sequential, an error ends the dispatch) — the recorder of
      // JobProcessing (a listener of JobEvent, after it) did not run; the job did.
      expect(app.seen.events.map((event) => event.constructor.name)).toEqual(['JobQueued', 'JobProcessed']);
    });
  });

  it('dispatches JobQueued of a job queued in a transaction only with its commit', async () => {
    await withApp(kind, async (app) => {
      const connections = app.container.make(Connections);
      await connections.transaction(async () => {
        await app.queue.dispatch(NoteJob, { n: 1 });
        expect(app.seen.events).toEqual([]);
      });
      expect(app.seen.events.map((event) => event.constructor.name)).toEqual(['JobQueued']);
    });
  });
});

describe.each(processKinds)('which queues a worker takes on %s', (kind) => {
  // A full default queue, one mail behind it, more default jobs after it.
  async function fill(app: TestApp): Promise<void> {
    for (let n = 1; n <= 20; n++) await app.queue.dispatch(NoteJob, { n });
    await app.queue.dispatch(NoteJob, { n: 100 }, { queue: 'mail' });
    for (let n = 21; n <= 40; n++) await app.queue.dispatch(NoteJob, { n });
  }

  it('without --queue: a mail behind a full default queue runs before the default jobs dispatched after it — not after all of them', async () => {
    await withApp(kind, async (app) => {
      app.clock.freeze();
      await fill(app);
      await app.work('every queue');
      const order = app.seen.entries.map((entry) => entry.n);
      expect(order, 'every job ran once').toHaveLength(41);
      // The database: the oldest due job first — the mail as the 21st. Redis: the queues in turn — the mail as the 2nd.
      const at = order.indexOf(100);
      expect(at, `the mail ran as job ${at + 1} of ${order.length}`).toBe(kind === 'redis' ? 1 : 20);
    });
  });

  it('with --queue=default,mail the order stays strict: the mail waits until the default queue is empty', async () => {
    await withApp(kind, async (app) => {
      app.clock.freeze();
      await fill(app);
      await app.work(['default', 'mail']);
      const order = app.seen.entries.map((entry) => entry.n);
      expect(order.indexOf(100), `the mail ran as job ${order.indexOf(100) + 1} of ${order.length}`).toBe(40);
    });
  });
});

describe('the queue beyond one driver', () => {
  it('works the listed queues first with --queue=default,* — then every other queue, oldest first', async () => {
    await withApp('sqlite', async (app) => {
      await app.queue.dispatch(NoteJob, { n: 1 }, { queue: 'reports' });
      await app.queue.dispatch(NoteJob, { n: 2 }, { queue: 'mail' });
      await app.queue.dispatch(NoteJob, { n: 3 });
      await app.work(['default', '*']);
      expect(app.seen.entries.map((entry) => entry.n)).toEqual([3, 1, 2]);
    });
  });

  it('a unique dispatch inside a transaction with a cache on the same SQLite file fails loudly, outside it works', async () => {
    await withApp(
      'sqlite',
      async (app) => {
        const connections = app.container.make(Connections);
        await expect(connections.transaction(() => app.queue.dispatch(NoteJob, { n: 1 }, { unique: 'report' }))).rejects.toBeInstanceOf(InfrastructureTransactionError);
        expect(await app.queue.dispatch(NoteJob, { n: 2 }, { unique: 'report' })).toEqual(expect.any(String));
      },
      { CACHE_DRIVER: 'database' },
    );
  });

  it('the sync connection runs a chain at once, in order, and stops at a failure (thrown to the dispatcher)', async () => {
    await withApp(
      'sqlite',
      async (app) => {
        await app.queue.chain([
          [NoteJob, { n: 1 }],
          [NoteJob, { n: 2 }],
        ]);
        expect(app.seen.entries.map((entry) => entry.n)).toEqual([1, 2]);
        await expect(
          app.queue.chain([
            [NoteJob, { n: 3, fail: true }],
            [NoteJob, { n: 4 }],
          ]),
        ).rejects.toThrow('note 3 failed');
        expect(app.seen.entries.map((entry) => entry.n)).toEqual([1, 2, 3]);
        // A unique sync job holds its key only while it runs.
        expect(await app.queue.dispatch(NoteJob, { n: 5 }, { unique: 'report' })).toEqual(expect.any(String));
        expect(await app.queue.dispatch(NoteJob, { n: 6 }, { unique: 'report' })).toEqual(expect.any(String));
      },
      { QUEUE_CONNECTION: 'sync' },
    );
  });
});

describe('QueueFake', () => {
  async function withFake(test: (app: TestApp & { fake: QueueFake }) => Promise<void>): Promise<void> {
    await withApp('sqlite', async (app) => {
      const fake = new QueueFake(app.container);
      app.container.instance(Queue, fake);
      await test(Object.assign(app, { fake, queue: fake }));
    });
  }

  it('respects unique locks like the real queue: a duplicate is not recorded until work() ran the first', async () => {
    await withFake(async ({ fake, container, seen }) => {
      expect(await fake.dispatch(NoteJob, { n: 1 }, { unique: 'stats:1', uniqueFor: 600 })).toEqual(expect.any(String));
      expect(await fake.dispatch(NoteJob, { n: 2 }, { unique: 'stats:1' })).toBeUndefined();
      fake.assertDispatchedTimes(NoteJob, 1);
      fake.assertDispatched(NoteJob, { n: 1 }, { unique: 'stats:1' });
      expect(() => fake.assertDispatched(NoteJob, { n: 1 }, { unique: 'stats:2' })).toThrow(/with the unique key "stats:2" \(unique keys dispatched: stats:1\)/);
      expect(fake.dispatched(NoteJob)[0]!.unique).toEqual({ key: 'stats:1', for: 600, until: 'done' });
      await fake.work();
      expect(seen.entries.map((entry) => entry.n)).toEqual([1]);
      expect(await fake.dispatch(NoteJob, { n: 3 }, { unique: 'stats:1' })).toEqual(expect.any(String));
      // A rollback frees the key, as in the real queue.
      const connections = container.make(Connections);
      await connections.transaction(async () => {
        await fake.dispatch(NoteJob, { n: 4 }, { unique: 'rolled-back' });
        throw new Rollback();
      }).catch(() => {});
      expect(await fake.dispatch(NoteJob, { n: 5 }, { unique: 'rolled-back' })).toEqual(expect.any(String));
      fake.assertNotDispatched(NoteJob, { n: 4 });
    });
  });

  it('assertChained, and work() runs a chain for real', async () => {
    await withFake(async ({ fake, seen }) => {
      await fake.chain([
        [NoteJob, { n: 1 }],
        [NoteJob, { n: 2 }],
      ]);
      fake.assertChained([NoteJob, NoteJob]);
      fake.assertChained([[NoteJob, { n: 1 }], [NoteJob, { n: 2 }]]);
      expect(() => fake.assertChained([[NoteJob, { n: 2 }], NoteJob])).toThrow('Expected the chain NoteJob → NoteJob. Chains dispatched: NoteJob → NoteJob.');
      expect(() => fake.assertChained([NoteJob])).toThrow(/Expected the chain NoteJob\./);
      // Only the first of a chain counts as dispatched — as in the real queue.
      fake.assertDispatchedTimes(NoteJob, 1);
      await fake.work();
      expect(seen.entries.map((entry) => entry.n)).toEqual([1, 2]);
    });
  });
});

if (!PGSQL_URL) describe.skip('unique jobs, chains and job.once on pgsql (set MARMEON_TEST_PGSQL_URL: pnpm test:pgsql)', () => it('runs', () => {}));
if (!REDIS_URL) describe.skip('unique jobs, chains and job.once on redis (set MARMEON_TEST_REDIS_URL: pnpm test:redis)', () => it('runs', () => {}));

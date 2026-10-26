import { Cache, CacheServiceProvider, type Lock } from '@marmeon/cache';
import { Clock, createApplication, Logger, type Application } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { migrate, silent } from './__fixtures__/targets.ts';
import { checkTimeouts, QueueConnections } from './connections.ts';
import { MemoryFailedJobStore, MemoryQueueDriver } from './drivers/memory.ts';
import { Queue, QueueServiceProvider, withoutOverlapping, type JobContext, type JobMiddleware, type JobMiddlewareContext } from './index.ts';
import { JobRegistry, QueueError, QueueSetupError } from './registry.ts';
import { runOnce } from './locks.ts';
import { JobRunner } from './runner.ts';
import { Worker } from './worker.ts';

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

/** What the middleware of this file saw. */
const seen: { timeoutSeconds?: unknown; oldName?: string }[] = [];

const readsTimeout: JobMiddleware = {
  async handle(context, next) {
    const entry: (typeof seen)[number] = { timeoutSeconds: context.timeoutSeconds };
    try {
      // @ts-expect-error `timeout` is `timeoutSeconds`
      void context.timeout;
    } catch (error) {
      entry.oldName = (error as Error).message;
    }
    seen.push(entry);
    await next();
  },
};

class LongJob {
  static readonly job = 'test.long';
  static readonly schema = v.object({});
  static readonly timeout = { minutes: 2 };
  static readonly middleware = [readsTimeout];
  handle(): void {}
}

class QuickJob {
  static readonly job = 'test.quick';
  static readonly schema = v.object({});
  static readonly timeout = { milliseconds: 100 };
  async handle(_payload: unknown, job: JobContext): Promise<void> {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      job.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('stopped'));
      });
    });
  }
}

class RetryingJob {
  static readonly job = 'test.retrying';
  static readonly schema = v.object({});
  static readonly tries = 3;
  static readonly backoff = [{ seconds: 10 }, { minutes: 1 }];
  handle(): void {}
}

class SingleBackoffJob {
  static readonly job = 'test.single-backoff';
  static readonly schema = v.object({});
  static readonly backoff = { minutes: 2 };
  handle(): void {}
}

async function app(): Promise<Application> {
  const application = await createApplication(
    { root: '/tmp', discover: false, providers: [DatabaseServiceProvider, EncryptionServiceProvider, CacheServiceProvider, QueueServiceProvider], modules: [{ name: 'test', jobs: [LongJob, QuickJob, RetryingJob, SingleBackoffJob] }] },
    {
      env: { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY, NODE_ENV: 'test', CACHE_DRIVER: 'memory' },
      override: (container) => {
        container.instance(Clock, new TestClock());
        container.instance(Logger, silent);
      },
    },
  );
  await migrate(application.container.make(Connections));
  return application;
}

function worker(application: Application) {
  const container = application.container;
  const runner = new JobRunner(container, container.make(JobRegistry), async () => container.make((await import('@marmeon/encryption')).Encrypter));
  const driver = new MemoryQueueDriver({ clock: container.make(Clock) });
  const failed = new MemoryFailedJobStore();
  return { driver, failed, worker: new Worker({ driver, connection: 'memory', runner, failed, clock: container.make(Clock), logger: silent }) };
}

const push = (driver: MemoryQueueDriver, job: string) =>
  driver.push('default', JSON.stringify({ v: 1, uuid: crypto.randomUUID(), job, data: {}, tries: 1, backoff: [], dispatchedAt: 0 }), 0);

describe('the spans of jobs and workers', () => {
  it('runs a job with a static timeout as a duration, and tells a middleware its seconds under timeoutSeconds (the old name throws)', async () => {
    await using application = await app();
    const { driver, worker: w } = worker(application);
    await push(driver, 'test.long');
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, failed: 0 });
    expect(seen.at(-1)).toMatchObject({ timeoutSeconds: 120 });
    expect(seen.at(-1)!.oldName).toBe('context.timeout is context.timeoutSeconds: a middleware reads the job timeout in seconds.');
  });

  it('aborts a job at a timeout given as a duration', async () => {
    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    await push(driver, 'test.quick');
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true, stopTimeout: { seconds: 1 } })).toMatchObject({ failed: 1 });
    expect((await failed.all())[0]!.exception).toMatch(/^JobTimeoutError: test\.quick timed out after 0\.1s/);
  });

  it('stores a backoff of durations as the seconds of the job record', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    await queue.dispatch(RetryingJob, {});
    await queue.dispatch(SingleBackoffJob, {});
    const rows = (await sql<{ payload: string }>`select payload from jobs order by id`.execute(application.container.make(Connections).get())).rows;
    expect(rows.map((row) => (JSON.parse(row.payload) as { backoff: number[] }).backoff)).toEqual([[10, 60], [120]]);
  });

  it('refuses a timeout or a backoff that is neither seconds nor a duration', () => {
    const schema = v.object({});
    const bad = (statics: Record<string, unknown>) => Object.assign(class { static readonly job = 'test.bad'; static readonly schema = schema; handle(): void {} }, statics);
    expect(() => new JobRegistry().add([bad({ timeout: '2m' })], 'module test')).toThrow(QueueSetupError);
    expect(() => new JobRegistry().add([bad({ timeout: { minutes: -1 } })], 'module test')).toThrow('static timeout must be seconds > 0 or a duration');
    expect(() => new JobRegistry().add([bad({ backoff: [10, '1m'] })], 'module test')).toThrow('static backoff must be seconds ≥ 0');
    expect(() => new JobRegistry().add([bad({ backoff: { minutes: 1 }, timeout: { seconds: 5 } })], 'module test')).not.toThrow();
  });

  it('takes the spans of a worker as durations', async () => {
    await using application = await app();
    const { driver, worker: w } = worker(application);
    expect(await w.run({ queues: ['default'], sleep: { milliseconds: 10 }, maxTime: { milliseconds: 50 }, stopTimeout: { seconds: 1 }, watchOtherQueues: { minutes: 5 } })).toMatchObject({ reason: 'max-time' });
    expect(driver.entries()).toEqual([]);
  });

  it('checks the timeout of a job given as a duration against the claim', () => {
    const registry = new JobRegistry().add([LongJob], 'module test');
    expect(() => checkTimeouts(registry, 'database', 130, 10)).toThrow('test.long (timeout 120s)');
    expect(() => checkTimeouts(registry, 'database', 131, 10)).not.toThrow();
  });

  it('takes the stop timeout of a worker for a connection as a duration', async () => {
    await using application = await app();
    expect(() => application.container.make(QueueConnections).worker('database', { seconds: 10 })).toThrow('test.long (timeout 120s)');
  });

  it('refuses a span of the worker that is not a span, before it claims a job', async () => {
    await using application = await app();
    const { driver, worker: w } = worker(application);
    await push(driver, 'test.long');
    await expect(w.run({ queues: ['default'], stopWhenEmpty: true, stopTimeout: { minutes: Number.NaN } })).rejects.toThrow(QueueError);
    await expect(w.run({ queues: ['default'], stopWhenEmpty: true, sleep: -1 })).rejects.toThrow('sleep must be seconds ≥ 0');
    await expect(w.run({ queues: ['default'], stopWhenEmpty: true, maxTime: Number.POSITIVE_INFINITY })).rejects.toThrow(QueueError);
    await expect(w.run({ queues: ['default'], stopWhenEmpty: true, watchOtherQueues: 0 })).rejects.toThrow('watchOtherQueues must be seconds > 0');
    expect(driver.entries()).toMatchObject([{ reserved: false, attempts: 0 }]);
  });
});

describe('job.once', () => {
  it('keeps the marker for a duration, and refuses a span that is not positive or not a span', async () => {
    await using application = await app();
    const cache = application.container.make(Cache);
    expect(await runOnce(async () => cache, 'a', () => {}, { for: { hours: 1 }, lockSeconds: 60 })).toBe(true);
    expect(await cache.ttlSeconds('queue:once:a')).toBe(3600);
    await expect(runOnce(async () => cache, 'b', () => {}, { for: 0, lockSeconds: 60 })).rejects.toThrow('must be seconds > 0');
    await expect(runOnce(async () => cache, 'c', () => {}, { for: '5s' as never, lockSeconds: 60 })).rejects.toThrow(QueueError);
  });
});

describe('withoutOverlapping', () => {
  const run = async (options: Parameters<typeof withoutOverlapping>[1], held: boolean) => {
    const taken: { seconds?: number } = {};
    const released: unknown[] = [];
    const cache = {
      lock: (_name: string, seconds: number): Lock => {
        taken.seconds = seconds;
        return { get: async () => !held, release: async () => true } as unknown as Lock;
      },
    } as unknown as Cache;
    const context = {
      payload: { key: 'a' },
      job: { name: 'test.guarded', release: (delay: unknown) => released.push(delay) },
      timeoutSeconds: 60,
      retryAfterSeconds: undefined,
      cache: async () => cache,
    } as unknown as JobMiddlewareContext;
    await withoutOverlapping('a', options).handle(context, async () => {});
    return { taken, released };
  };

  it('takes the lock for expiresAfter and the wait of releaseAfter as durations', async () => {
    expect((await run({ expiresAfter: { minutes: 3 } }, false)).taken.seconds).toBe(180);
    expect((await run({ releaseAfter: { seconds: 20 } }, true)).released).toEqual([20]);
    expect((await run({}, false)).taken.seconds).toBe(120);
  });

  it('refuses an expiresAfter that is not a positive span', async () => {
    await expect(run({ expiresAfter: 0 }, false)).rejects.toThrow('expiresAfter must be seconds > 0');
    expect(() => withoutOverlapping('a', { expiresAfter: '5s' as never })).toThrow(QueueError);
    expect(() => withoutOverlapping('a', { releaseAfter: -1 })).toThrow('releaseAfter must be seconds ≥ 0');
  });
});

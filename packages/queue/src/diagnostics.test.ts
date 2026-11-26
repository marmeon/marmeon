import { Clock, createApplication, Logger, type Application } from '@marmeon/core';
import { runWithRequest } from '@marmeon/core/internal';
import { channels, type QueueDispatchMessage, type QueueJobMessage } from '@marmeon/core/diagnostics';
import { Connections, DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { migrate, silent } from './__fixtures__/targets.ts';
import { QueueConnections } from './connections.ts';
import { QueueFake } from './fake.ts';
import { Queue, QueueServiceProvider, type JobContext, type JobRecord } from './index.ts';
import { cipherContext, isEncryptedJob, parseRecord } from './runner.ts';

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

class StatsJob {
  static readonly job = 'test.stats';
  static readonly schema = v.object({ userId: v.number() });
  handle(payload: { userId: number }, job: JobContext) {
    if (payload.userId === 0) job.discard('no user');
  }
}

/** Dispatches a StatsJob — a second hop (a queued listener queues a mail). */
class FanOutJob {
  static readonly job = 'test.fan-out';
  static readonly schema = v.object({});
  readonly #queue: Queue;
  constructor(queue: Queue) {
    this.#queue = queue;
  }
  async handle() {
    await this.#queue.dispatch(StatsJob, { userId: 7 });
  }
}

/** Counts its runs: a plain record for it must never run. */
const ran: string[] = [];

/** A JS job: `encrypted` is truthy but not `true`; the queue encrypts its payload all the same. */
class TruthyJob {
  static readonly job = 'test.truthy';
  static readonly schema = v.object({ secret: v.string() });
  static readonly encrypted = 1 as never;
  handle() {
    ran.push('truthy');
  }
}

class SecretStatsJob {
  static readonly job = 'test.secret-stats';
  static readonly schema = v.object({ userId: v.number() });
  static readonly encrypted = true;
  handle() {
    ran.push('secret-stats');
  }
}

class BrokenJob {
  static readonly job = 'test.broken';
  static readonly schema = v.object({});
  handle() {
    throw new Error('the report service is down');
  }
}

async function boot(): Promise<Application> {
  const application = await createApplication({
    root: '/tmp',
    discover: false,
    providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider],
    modules: [{ name: 'test', jobs: [StatsJob, BrokenJob, FanOutJob, TruthyJob, SecretStatsJob] }],
  }, { env: { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY, NODE_ENV: 'test' }, override: (container) => container.instance(Logger, silent) });
  await migrate(application.container.make(Connections));
  return application;
}

const work = (application: Application) => application.container.make(QueueConnections).worker('database', 10).run({ queues: ['default'], stopWhenEmpty: true });

describe('job metadata', () => {
  it('a job dispatched in a request carries the request\'s id — always, also without a subscriber', async () => {
    await using application = await boot();
    const queue = application.container.make(Queue);
    await runWithRequest({ requestId: 'req-5' }, () => queue.dispatch(StatsJob, { userId: 5 }));
    await queue.dispatch(StatsJob, { userId: 6 });
    const rows = await application.container.make(Connections).get().selectFrom('jobs' as never).select('payload' as never).orderBy('id' as never).execute();
    const records = (rows as { payload: string }[]).map((row) => (parseRecord(row.payload) as { record: JobRecord }).record);
    expect(records.map((record) => record.requestId)).toEqual(['req-5', undefined]);
    expect(records.every((record) => record.traceparent === undefined)).toBe(true);
    expect(channels.built(application)).toBe(0);
  });

  it('a job dispatched by such a job carries the request on — the second hop (a queued listener queueing a mail)', async () => {
    await using application = await boot();
    const queue = application.container.make(Queue);
    const seen: (string | undefined)[] = [];
    const off = channels.subscribe(application, 'queue.job', { start: (attempt) => void seen.push(`${attempt.job} ${attempt.originRequestId}`) });
    try {
      await runWithRequest({ requestId: 'req-8' }, () => queue.dispatch(FanOutJob, {}));
      await work(application);
    } finally {
      off();
    }
    expect(seen).toEqual(['test.fan-out req-8', 'test.stats req-8']);
  });
});

describe('the queue.dispatch and queue.job channels', () => {
  it('a tracer\'s traceparent travels with the job — set in its dispatch start, read in the worker\'s attempt', async () => {
    await using application = await boot();
    const queue = application.container.make(Queue);
    const dispatched: QueueDispatchMessage[] = [];
    const attempts: QueueJobMessage[] = [];
    const offs = [
      channels.subscribe(application, 'queue.dispatch', {
        // What @marmeon/otel will do: put the current trace context on the message.
        start: (message) => void (message.traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`),
        end: (message) => void dispatched.push(message),
      }),
      channels.subscribe(application, 'queue.job', { end: (message) => void attempts.push(message) }),
    ];
    try {
      const id = await runWithRequest({ requestId: 'req-9' }, () => queue.dispatch(StatsJob, { userId: 9 }, { delay: 0 }));
      await queue.bulk([[StatsJob, { userId: 0 }], [BrokenJob, {}]]);
      await work(application);
      expect(dispatched.map(({ kind, jobs, jobIds, queue: name, connection, requestId }) => ({ kind, jobs, ids: jobIds.length, name, connection, requestId }))).toEqual([
        { kind: 'dispatch', jobs: ['test.stats'], ids: 1, name: 'default', connection: 'database', requestId: 'req-9' },
        { kind: 'bulk', jobs: ['test.stats', 'test.broken'], ids: 2, name: 'default', connection: 'database', requestId: undefined },
      ]);
      expect(dispatched[0]!.jobIds).toEqual([id]);
      expect(attempts.map(({ job, outcome, originRequestId, traceparent, attempt }) => ({ job, outcome, originRequestId, traceparent: traceparent?.slice(0, 8), attempt }))).toEqual([
        { job: 'test.stats', outcome: 'done', originRequestId: 'req-9', traceparent: '00-aaaaa', attempt: 1 },
        { job: 'test.stats', outcome: 'discarded', originRequestId: undefined, traceparent: '00-aaaaa', attempt: 1 },
        { job: 'test.broken', outcome: undefined, originRequestId: undefined, traceparent: '00-aaaaa', attempt: 1 },
      ]);
      expect((attempts[2]!.error as Error).message).toBe('the report service is down');
      expect(attempts.every((attempt) => typeof attempt.durationMs === 'number' && attempt.connection === 'database' && attempt.queue === 'default')).toBe(true);
    } finally {
      for (const off of offs) off();
    }
  });
});

const SECRET = 'hunter2-the-secret-value';

/** Queues a record as it is, as an older release or another app would have. */
async function pushRecord(application: Application, record: Record<string, unknown>): Promise<void> {
  const full = { v: 1, uuid: crypto.randomUUID(), tries: 1, backoff: [], dispatchedAt: application.container.make(Clock).now(), ...record };
  await application.container.make(QueueConnections).driver('database').push('default', JSON.stringify(full), 0);
}

/** The `queue.job` messages of the attempts a worker run makes. */
async function attemptsOf(application: Application): Promise<QueueJobMessage[]> {
  const attempts: QueueJobMessage[] = [];
  const off = channels.subscribe(application, 'queue.job', { end: (message) => void attempts.push(message) });
  try {
    await work(application);
  } finally {
    off();
  }
  return attempts;
}

describe('a job whose `encrypted` is truthy but not true', () => {
  it('is encrypted on the queue.dispatch message', async () => {
    await using application = await boot();
    const dispatched: QueueDispatchMessage[] = [];
    const off = channels.subscribe(application, 'queue.dispatch', { end: (message) => void dispatched.push(message) });
    try {
      await application.container.make(Queue).dispatch(TruthyJob, { secret: SECRET });
      expect(dispatched.map((message) => message.encrypted)).toEqual([[true]]);
    } finally {
      off();
    }
  });

  it('is encrypted on the queue.job message, and runs to done', async () => {
    await using application = await boot();
    await application.container.make(Queue).dispatch(TruthyJob, { secret: SECRET });
    const attempts = await attemptsOf(application);
    expect(attempts.map(({ outcome, encrypted }) => ({ outcome, encrypted }))).toEqual([{ outcome: 'done', encrypted: true }]);
    expect(ran).toContain('truthy');
  });

  it('is stored as a ciphertext, flagged encrypted, without the secret', async () => {
    await using application = await boot();
    await application.container.make(Queue).dispatch(TruthyJob, { secret: SECRET });
    const reserved = await application.container.make(QueueConnections).driver('database').reserve(['default']);
    const record = JSON.parse(reserved!.payload) as { data: unknown; encrypted?: unknown };
    expect(typeof record.data).toBe('string');
    expect(record.encrypted).toBe(true);
    expect(reserved!.payload).not.toContain(SECRET);
  });

  it('names fields only in the error of a payload that does not match its schema at dispatch', async () => {
    await using application = await boot();
    const error = await application.container.make(Queue).dispatch(TruthyJob, { secret: 12345678 } as never).then(() => undefined, (caught: Error) => caught);
    expect(error?.message).toBe('The data of test.truthy does not match its schema (fields: secret).');
  });

  it('is encrypted on the QueueFake dispatch message too', async () => {
    await using application = await boot();
    const fake = new QueueFake(application.container);
    const dispatched: QueueDispatchMessage[] = [];
    const off = channels.subscribe(application, 'queue.dispatch', { end: (message) => void dispatched.push(message) });
    try {
      await fake.dispatch(TruthyJob, { secret: SECRET });
      expect(dispatched.map((message) => message.encrypted)).toEqual([[true]]);
    } finally {
      off();
    }
  });

  it('refuses a plain record: poisoned with its reason, never run', async () => {
    await using application = await boot();
    ran.length = 0;
    await pushRecord(application, { job: 'test.truthy', data: { secret: SECRET } });
    const attempts = await attemptsOf(application);
    expect(attempts.map((attempt) => (attempt.error as Error).message)).toEqual(['test.truthy takes an encrypted payload (static encrypted), but this one is plain — not queued by this app.']);
    expect(ran).toEqual([]);
  });
});

describe('a record queued as encrypted for a class without `static encrypted`', () => {
  it('is an encrypted attempt on queue.job', async () => {
    await using application = await boot();
    const connections = application.container.make(QueueConnections);
    const data = await (await connections.cipher()).encrypt(JSON.stringify({ userId: 7 }), cipherContext('test.stats', 1));
    await pushRecord(application, { job: 'test.stats', data, encrypted: true });
    const attempts = await attemptsOf(application);
    expect(attempts.map(({ job, outcome, encrypted }) => ({ job, outcome, encrypted }))).toEqual([{ job: 'test.stats', outcome: 'done', encrypted: true }]);
  });
});

describe('a plain record for a class with `static encrypted`', () => {
  it('is poisoned and its queue.job message carries no payload', async () => {
    await using application = await boot();
    ran.length = 0;
    await pushRecord(application, { job: 'test.secret-stats', data: { userId: 7 } });
    const attempts = await attemptsOf(application);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.encrypted).toBe(true);
    expect('payload' in attempts[0]!).toBe(false);
    expect(ran).toEqual([]);
  });
});

describe('isEncryptedJob', () => {
  const withStatic = (value: unknown) => class { static readonly encrypted = value; };

  it('is true for a class whose `encrypted` is truthy', () => {
    for (const value of [1, 'yes', true]) expect(isEncryptedJob(withStatic(value))).toBe(true);
  });

  it('is false for a class whose `encrypted` is falsy or missing', () => {
    for (const value of [0, '', false, undefined]) expect(isEncryptedJob(withStatic(value))).toBe(false);
    expect(isEncryptedJob(class {})).toBe(false);
  });

  it('is false for null and primitives, and throws for none', () => {
    for (const value of [null, undefined, 'x', 5]) expect(isEncryptedJob(value)).toBe(false);
  });

  it('judges a plain object by its `encrypted` too — a JS caller\'s value is not trusted to be a class', () => {
    expect(isEncryptedJob({ encrypted: true })).toBe(true);
    expect(isEncryptedJob({})).toBe(false);
  });
});

describe('the queue.dispatch subscriber and a call that is no job', () => {
  it('rejects with the same error as without a subscriber', async () => {
    await using application = await boot();
    const queue = application.container.make(Queue);
    const without = await queue.dispatch(null as never, {} as never).then(() => undefined, (caught: Error) => caught);
    const off = channels.subscribe(application, 'queue.dispatch', { end: () => {} });
    try {
      const withOne = await queue.dispatch(null as never, {} as never).then(() => undefined, (caught: Error) => caught);
      expect(without).toBeInstanceOf(Error);
      expect(withOne?.constructor).toBe(without?.constructor);
      expect(withOne?.message).toBe(without?.message);
    } finally {
      off();
    }
  });
});

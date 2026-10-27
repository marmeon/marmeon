import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Clock, createApplication, currentLogContext, listen, Logger, Redactor, type Application, type ModuleDefinition } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { channels, type QueueJobMessage } from '@marmeon/core/diagnostics';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { migrate, silent } from './__fixtures__/targets.ts';
import { checkTimeouts } from './connections.ts';
import type { JobRecord, QueueDriver } from './driver.ts';
import { MemoryFailedJobStore, MemoryQueueDriver } from './drivers/memory.ts';
import { parseMember } from './drivers/redis.ts';
import { QueueFake } from './fake.ts';
import type { JobEvent } from './events.ts';
import { JobFailed, JobQueued, JobReleased, Queue, QueueServiceProvider, type JobContext, type JobPayload } from './index.ts';
import { JobRegistry, QueueSetupError } from './registry.ts';
import { cipherContext, JobPayloadError, JobRunner, nextInChain, parseRecord, RECORD_READERS } from './runner.ts';
import { JobStuckError, Worker } from './worker.ts';

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

/** Something scoped: one per attempt (a job's scope), never shared between attempts. */
class UnitOfWork {
  readonly id = crypto.randomUUID();
}

/** What the jobs of this file saw — a test-only recorder, injected. */
class Seen {
  readonly entries: { job: string; payload: unknown; attempt: number; id: string; unit?: string; log?: Record<string, unknown> }[] = [];
  /** The ids of the `JobQueued` events, in order. */
  readonly queued: string[] = [];
}

/** Records every `JobQueued`. */
class QueuedRecorder {
  readonly #seen: Seen;

  constructor(seen: Seen) {
    this.#seen = seen;
  }

  handle(event: JobQueued): void {
    this.#seen.queued.push(event.jobId);
  }
}

class WelcomeJob {
  static readonly job = 'test.welcome';
  static readonly schema = v.object({ userId: v.number() });

  readonly #seen: Seen;
  readonly #unit: UnitOfWork;

  constructor(seen: Seen, unit: UnitOfWork) {
    this.#seen = seen;
    this.#unit = unit;
  }

  async handle(payload: JobPayload<typeof WelcomeJob>, job: JobContext): Promise<void> {
    this.#seen.entries.push({ job: job.name, payload, attempt: job.attempt, id: job.id, unit: this.#unit.id, log: { ...currentLogContext() } });
  }
}

/** Fails until its third attempt; the error carries a secret the failed entry must not keep. */
class FlakyJob {
  static readonly job = 'test.flaky';
  static readonly schema = v.object({ failUntil: v.number() });
  static readonly tries = 3;
  static readonly backoff = [10, 60];

  readonly #seen: Seen;

  constructor(seen: Seen) {
    this.#seen = seen;
  }

  async handle(payload: JobPayload<typeof FlakyJob>, job: JobContext): Promise<void> {
    this.#seen.entries.push({ job: job.name, payload, attempt: job.attempt, id: job.id });
    if (job.attempt < payload.failUntil) {
      throw Object.assign(new Error(`SMTP said no (password=hunter2, url postgres://app:s3cret@db/app)`), { token: 'abc', code: 'EAUTH' });
    }
  }
}

/** Ends itself in the way its payload says. */
class ChoosyJob {
  static readonly job = 'test.choosy';
  static readonly schema = v.object({ choice: v.picklist(['discard', 'release', 'fail']) });
  static readonly tries = 2;

  async handle(payload: JobPayload<typeof ChoosyJob>, job: JobContext): Promise<void> {
    if (payload.choice === 'discard') job.discard('nothing to do');
    if (payload.choice === 'release') job.release({ seconds: 30 });
    if (payload.choice === 'fail') job.fail('the account is gone');
  }
}

/** Honors its signal: stops when the timeout aborts it. */
class PoliteSlowJob {
  static readonly job = 'test.polite-slow';
  static readonly schema = v.object({});
  static readonly timeout = 0.1;
  static readonly tries = 2;

  async handle(_payload: JobPayload<typeof PoliteSlowJob>, job: JobContext): Promise<void> {
    await sleep(5000, undefined, { signal: job.signal });
  }
}

/** Ignores its signal. */
class RudeSlowJob {
  static readonly job = 'test.rude-slow';
  static readonly schema = v.object({});
  static readonly timeout = 0.1;

  async handle(): Promise<void> {
    await sleep(2000);
  }
}

/** Carries a secret: its payload is encrypted in the queue. */
class ResetLinkJob {
  static readonly job = 'test.reset-link';
  static readonly schema = v.object({ email: v.string(), token: v.string() });
  static readonly encrypted = true;

  readonly #seen: Seen;

  constructor(seen: Seen) {
    this.#seen = seen;
  }

  async handle(payload: JobPayload<typeof ResetLinkJob>, job: JobContext): Promise<void> {
    this.#seen.entries.push({ job: job.name, payload, attempt: job.attempt, id: job.id });
  }
}

/** Fails with the value of a name only the app knows is secret (its session cookie's, as @marmeon/session adds it). */
class LeakyJob {
  static readonly job = 'test.leaky';
  static readonly schema = v.object({});
  handle(): void {
    throw Object.assign(new Error('the store refused shop_session=s3ss10nvalue'), { shop_session: 'pr0pvalue' });
  }
}

const allJobs = [WelcomeJob, FlakyJob, ChoosyJob, PoliteSlowJob, RudeSlowJob, ResetLinkJob, LeakyJob];

/** A real app: database (SQLite in memory, migrated), queue, encryption — the jobs in one module. */
async function app(options: { env?: Record<string, string>; modules?: ModuleDefinition[]; clock?: TestClock; logger?: Logger } = {}): Promise<Application & { seen: Seen; clock: TestClock }> {
  const clock = options.clock ?? new TestClock();
  const seen = new Seen();
  const application = await createApplication({
    root: '/tmp',
    discover: false,
    providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider],
    modules: options.modules ?? [{ name: 'test', jobs: allJobs }],
  }, {
    env: { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY, NODE_ENV: 'test', ...options.env },
    override: (container) => {
      container.instance(Clock, clock);
      container.instance(Seen, seen);
      container.scoped(UnitOfWork);
      container.instance(Logger, options.logger ?? silent);
    },
  });
  await migrate(application.container.make(Connections));
  return Object.assign(application, { seen, clock });
}

function worker(application: Application, driver = new MemoryQueueDriver({ clock: application.container.make(Clock) }), failed = new MemoryFailedJobStore()) {
  const container = application.container;
  const runner = new JobRunner(container, container.make(JobRegistry), async () => container.make((await import('@marmeon/encryption')).Encrypter));
  return { driver, failed, worker: new Worker({ driver, connection: 'memory', runner, failed, clock: container.make(Clock), logger: silent }) };
}

async function push(application: Application, driver: MemoryQueueDriver, job: string, data: unknown, extra: Record<string, unknown> = {}): Promise<string> {
  const uuid = crypto.randomUUID();
  await driver.push('default', JSON.stringify({ v: 1, uuid, job, data, tries: 1, backoff: [], dispatchedAt: application.container.make(Clock).now(), ...extra }), 0);
  return uuid;
}

describe('the job registry', () => {
  it('fails the start when two jobs share a name, naming both and their modules', async () => {
    class Copy {
      static readonly job = 'test.welcome';
      static readonly schema = v.object({});
      handle() {}
    }
    await expect(app({ modules: [{ name: 'a', jobs: [WelcomeJob] }, { name: 'b', jobs: [Copy] }] })).rejects.toThrow(
      'Two jobs are named "test.welcome": WelcomeJob (module a) and Copy (module b).',
    );
  });

  it('rejects a class without a stable name, a schema or handle()', () => {
    const registry = new JobRegistry();
    class NoName {
      static readonly schema = v.object({});
      handle() {}
    }
    class ClassName {
      static readonly job = 'SendMail';
      static readonly schema = v.object({});
      handle() {}
    }
    class NoSchema {
      static readonly job = 'test.no-schema';
      handle() {}
    }
    class NoHandle {
      static readonly job = 'test.no-handle';
      static readonly schema = v.object({});
    }
    class Framework {
      static readonly job = 'marmeon.mail';
      static readonly schema = v.object({});
      handle() {}
    }
    expect(() => registry.add([NoName as never], 'module x')).toThrow(/NoName \(module x\) needs a stable name: static job = 'module\.what-it-does'/);
    expect(() => registry.add([ClassName as never], 'module x')).toThrow(/"SendMail" is not one/);
    expect(() => registry.add([NoSchema as never], 'module x')).toThrow(/needs static schema/);
    expect(() => registry.add([NoHandle as never], 'module x')).toThrow(/needs a handle\(payload, job\) method/);
    expect(() => registry.add([Framework], 'module x')).toThrow(/names under "marmeon\." belong to the framework/);
  });
});

describe('dispatching', () => {
  it('checks the payload against the schema — at dispatch, as JSON — and refuses unregistered jobs', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    const error = await queue.dispatch(WelcomeJob, { userId: 'x' } as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobPayloadError);
    expect((error as Error).message).toBe('The payload of test.welcome does not match its schema: userId: Invalid type: Expected number but received "x"');
    class Unregistered {
      static readonly job = 'test.unregistered';
      static readonly schema = v.object({});
      handle() {}
    }
    await expect(queue.dispatch(Unregistered, {})).rejects.toThrow(
      'Unregistered (test.unregistered) is not registered — a worker could not run it. Add it to its module: defineModule({ jobs: [Unregistered] }).',
    );
    class Impostor {
      static readonly job = 'test.welcome';
      static readonly schema = v.object({ userId: v.number() });
      handle() {}
    }
    await expect(queue.dispatch(Impostor, { userId: 1 })).rejects.toThrow('Impostor is named "test.welcome", but that name belongs to WelcomeJob');
    expect(await queue.size()).toBe(0);
  });

  it('queues into the jobs table and the worker runs it in its own scope, with the job log context', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    const id = await queue.dispatch(WelcomeJob, { userId: 7 });
    await queue.dispatch(WelcomeJob, { userId: 8 }, { queue: 'mail' });
    expect(await queue.size()).toBe(1);
    expect(await queue.size('mail')).toBe(1);
    expect(await queue.size('mail', { connection: 'database' })).toBe(1);
    // A string as the second argument is refused: it would count the default connection.
    await expect(queue.size('mail', 'database' as never)).rejects.toThrow('size("mail", "database") takes the connection in an options object — size(queue, { connection: "database" })');

    const { QueueConnections } = await import('./connections.ts');
    const result = await application.container.make(QueueConnections).worker('database', 10).run({ queues: ['mail', 'default'], stopWhenEmpty: true });
    expect(result).toMatchObject({ processed: 2, failed: 0, reason: 'empty' });
    const [first, second] = application.seen.entries;
    expect(first).toMatchObject({ payload: { userId: 8 } });
    expect(second).toMatchObject({ payload: { userId: 7 }, id, attempt: 1, log: { job: 'test.welcome', jobId: id, attempt: 1 } });
    expect(first!.unit).not.toBe(second!.unit); // a scope per job
    expect(await queue.size()).toBe(0);
  });

  it('bulk-queues several jobs, none if one payload is wrong', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    await expect(queue.bulk([[WelcomeJob, { userId: 1 }], [WelcomeJob, { userId: 'two' } as never]])).rejects.toThrow(JobPayloadError);
    expect(await queue.size()).toBe(0);
    const ids = await queue.bulk([[WelcomeJob, { userId: 1 }], [FlakyJob, { failUntil: 1 }]]);
    expect(ids).toHaveLength(2);
    expect(await queue.size()).toBe(2);
  });

  it('writes through a transaction: a rollback leaves no job', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    const db = application.container.make(Connections).get();
    await db
      .transaction()
      .execute(async (trx) => {
        await queue.using(trx).dispatch(WelcomeJob, { userId: 1 });
        expect(await queue.using(trx).size()).toBe(1);
        throw new Error('rolled back');
      })
      .catch(() => {});
    expect(await queue.size()).toBe(0);
    await db.transaction().execute((trx) => queue.using(trx).dispatch(WelcomeJob, { userId: 2 }));
    expect(await queue.size()).toBe(1);
    expect(() => queue.using({} as never)).toThrow(/takes a database transaction/);
  });

  it('runs a job at once with the sync connection — in its own scope; its error reaches the caller', async () => {
    await using application = await app({ env: { QUEUE_DRIVER: 'sync' } });
    const queue = application.container.make(Queue);
    await queue.dispatch(WelcomeJob, { userId: 3 });
    expect(application.seen.entries).toMatchObject([{ payload: { userId: 3 }, attempt: 1 }]);
    await expect(queue.dispatch(FlakyJob, { failUntil: 2 })).rejects.toThrow(/SMTP said no/);
    await expect(queue.dispatch(ChoosyJob, { choice: 'release' })).rejects.toThrow(/the sync connection runs a job only once/);
    await expect(queue.dispatch(ChoosyJob, { choice: 'fail' })).rejects.toThrow(/the account is gone/);
    await queue.dispatch(ChoosyJob, { choice: 'discard' });
    expect(await queue.size()).toBe(0);
  });

  describe('through queue.using(trx)', () => {
    class Rollback extends Error {}
    const recording = [{ name: 'test', jobs: allJobs, listeners: [listen(JobQueued, QueuedRecorder)] }];

    it('runs a sync job only after the commit, never after a rollback', async () => {
      await using application = await app({ env: { QUEUE_DRIVER: 'sync' } });
      const queue = application.container.make(Queue);
      const connections = application.container.make(Connections);
      await expect(
        connections.transaction(async (trx) => {
          await queue.using(trx).dispatch(WelcomeJob, { userId: 1 });
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(application.seen.entries).toEqual([]);
      await connections.transaction(async (trx) => {
        await queue.using(trx).dispatch(WelcomeJob, { userId: 2 });
        expect(application.seen.entries).toEqual([]);
      });
      expect(application.seen.entries).toMatchObject([{ payload: { userId: 2 } }]);
    });

    it('refuses a sync job through a transaction the app began itself — nothing tells the queue how it ends', async () => {
      await using application = await app({ env: { QUEUE_DRIVER: 'sync' }, modules: recording });
      const queue = application.container.make(Queue);
      const db = application.container.make(Connections).get();
      await expect(db.transaction().execute((trx) => queue.using(trx).dispatch(WelcomeJob, { userId: 1 }))).rejects.toThrow(/sync queue cannot run a job for a transaction you began yourself/);
      expect(application.seen.entries).toEqual([]);
      expect(application.seen.queued).toEqual([]);
    });

    it('refuses a sync job through a savepoint the app began itself inside connections.transaction(), although the outer commits', async () => {
      await using application = await app({ env: { QUEUE_DRIVER: 'sync' }, modules: recording });
      const queue = application.container.make(Queue);
      const connections = application.container.make(Connections);
      const db = connections.get();
      await connections.transaction(async () => {
        const trx = await db.startTransaction().execute();
        await expect(queue.using(trx).dispatch(WelcomeJob, { userId: 1 })).rejects.toThrow(/sync queue cannot run a job for a transaction you began yourself/);
        await trx.rollback().execute();
      });
      expect(application.seen.entries).toEqual([]);
      expect(application.seen.queued).toEqual([]);
    });

    it('fires no JobQueued for a savepoint the app began itself inside connections.transaction(), although the outer commits', async () => {
      await using application = await app({ modules: recording });
      const queue = application.container.make(Queue);
      const connections = application.container.make(Connections);
      const db = connections.get();
      await connections.transaction(async () => {
        const trx = await db.startTransaction().execute();
        await queue.using(trx).dispatch(WelcomeJob, { userId: 1 });
        await trx.rollback().execute();
      });
      expect(application.seen.queued).toEqual([]);
      expect(await queue.size()).toBe(0);
    });

    it('reports JobQueued after the commit, and not at all after a rollback', async () => {
      await using application = await app({ modules: recording });
      const queue = application.container.make(Queue);
      const connections = application.container.make(Connections);
      await expect(
        connections.transaction(async (trx) => {
          await queue.using(trx).dispatch(WelcomeJob, { userId: 1 });
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(application.seen.queued).toEqual([]);
      let id = '';
      await connections.transaction(async (trx) => {
        id = await queue.using(trx).dispatch(WelcomeJob, { userId: 2 });
        expect(application.seen.queued).toEqual([]);
      });
      expect(application.seen.queued).toEqual([id]);
    });
  });

  it('encrypts the payload of a static encrypted job — no plaintext in jobs or failed_jobs', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    await queue.dispatch(ResetLinkJob, { email: 'ada@example.com', token: 'plain-secret-token' });
    const db = application.container.make(Connections).get();
    const { rows } = await sql<{ payload: string }>`select payload from jobs`.execute(db);
    expect(rows[0]!.payload).not.toContain('plain-secret-token');
    expect(rows[0]!.payload).not.toContain('ada@example.com');
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ job: 'test.reset-link', encrypted: true });

    const { QueueConnections } = await import('./connections.ts');
    await application.container.make(QueueConnections).worker('database', 10).run({ queues: ['default'], stopWhenEmpty: true });
    expect(application.seen.entries).toMatchObject([{ payload: { email: 'ada@example.com', token: 'plain-secret-token' } }]);
  });
});

describe('the worker', () => {
  it('retries with the backoff of the dispatch (on the queue clock), then records the failure — redacted, same job id', async () => {
    const logged: string[] = [];
    const capture: Logger = { debug() {}, info() {}, warn: (message) => logged.push(message), error: (message) => logged.push(message), child: () => capture };
    await using application = await app({ logger: capture });
    application.clock.freeze();
    const queue = application.container.make(Queue);
    const { QueueConnections } = await import('./connections.ts');
    const connections = application.container.make(QueueConnections);
    const id = await queue.dispatch(FlakyJob, { failUntil: 9 });
    const work = () => connections.worker('database', 10).run({ queues: ['default'], stopWhenEmpty: true });

    expect(await work()).toMatchObject({ processed: 1, released: 1 });
    expect(await work()).toMatchObject({ processed: 0 }); // waits 10 s
    application.clock.travel({ seconds: 10 });
    expect(await work()).toMatchObject({ processed: 1, released: 1 });
    application.clock.travel({ seconds: 59 });
    expect(await work()).toMatchObject({ processed: 0 });
    application.clock.travel({ seconds: 1 });
    expect(await work()).toMatchObject({ processed: 1, failed: 1 });

    expect(application.seen.entries.map((entry) => [entry.attempt, entry.id])).toEqual([
      [1, id],
      [2, id],
      [3, id],
    ]);
    const [failed] = await connections.failed().all();
    expect(failed).toMatchObject({ uuid: id, job: 'test.flaky', connection: 'database', queue: 'default' });
    expect(failed!.exception).toContain('Error: SMTP said no (password=[redacted], url postgres://app:***@db/app)');
    expect(failed!.exception).toContain('"token":"[redacted]"');
    expect(failed!.exception).toContain('"code":"EAUTH"');
    expect(failed!.exception).not.toMatch(/hunter2|s3cret|"abc"/);
    expect(logged).toEqual([
      'Attempt 1 of 3 of test.flaky failed, again in 10s: SMTP said no (password=[redacted], url postgres://app:***@db/app)',
      'Attempt 2 of 3 of test.flaky failed, again in 60s: SMTP said no (password=[redacted], url postgres://app:***@db/app)',
      'Failed test.flaky after 3 attempts: SMTP said no (password=[redacted], url postgres://app:***@db/app)',
    ]);
    expect(await queue.size()).toBe(0);
  });

  it("records and logs a failure masked by the app's Redactor — the names its packages add count too, not only the core's", async () => {
    const logged: string[] = [];
    const capture: Logger = { debug() {}, info() {}, warn: (message) => logged.push(message), error: (message) => logged.push(message), child: () => capture };
    await using application = await app({ logger: capture });
    application.container.make(Redactor).addKeys('shop_session');
    await application.container.make(Queue).dispatch(LeakyJob, {});
    const { QueueConnections } = await import('./connections.ts');
    const connections = application.container.make(QueueConnections);
    expect(await connections.worker('database', 10).run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ failed: 1 });
    const [failed] = await connections.failed().all();
    expect(failed!.exception).toContain('the store refused shop_session=[redacted]');
    expect(failed!.exception, failed!.exception).not.toMatch(/s3ss10nvalue|pr0pvalue/);
    expect(logged, JSON.stringify(logged)).toEqual(['Failed test.leaky: the store refused shop_session=[redacted]']);
  });

  it("logs a failing listener of a dispatch masked by the app's Redactor — the session cookie its error quotes stays out", async () => {
    const logged: string[] = [];
    const capture: Logger = { debug() {}, info() {}, warn: (message) => logged.push(message), error: (message) => logged.push(message), child: () => capture };
    class LeakyListener {
      handle() {
        throw new Error('the audit log refused Cookie: a=1; marmeon_session=s3ss10nvalue');
      }
    }
    await using application = await app({ logger: capture, modules: [{ name: 'test', jobs: allJobs, listeners: [listen(JobQueued, LeakyListener)] }] });
    // What the session package does at boot: the session cookie's name joins the app's Redactor.
    application.container.make(Redactor).addKeys('marmeon_session');
    await application.container.make(Queue).dispatch(LeakyJob, {});
    expect(logged, JSON.stringify(logged)).toEqual(['A listener of JobQueued failed: the audit log refused Cookie: [redacted]; marmeon_session=[redacted]']);
  });

  it('lets a job discard, release or fail itself', async () => {
    await using application = await app();
    application.clock.freeze();
    const { driver, failed, worker: w } = worker(application);
    await push(application, driver, 'test.choosy', { choice: 'discard' });
    await push(application, driver, 'test.choosy', { choice: 'release' }, { tries: 2 });
    const failing = await push(application, driver, 'test.choosy', { choice: 'fail' }, { tries: 2 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 3, released: 1, failed: 1 });
    expect(driver.entries()).toMatchObject([{ attempts: 1, reserved: false, availableAt: application.clock.now() + 30_000 }]);
    expect(await failed.all()).toMatchObject([{ uuid: failing, exception: expect.stringContaining('Error: the account is gone') }]);
  });

  it('fails a payload that cannot run at once: no job record, a forged plaintext for an encrypted job', async () => {
    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    await driver.push('default', 'not json', 0);
    await push(application, driver, 'test.reset-link', { email: 'a@b.c', token: 't' }, { tries: 5 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 2, failed: 2, released: 0 });
    const exceptions = (await failed.all()).map((job) => job.exception.split('\n')[0]).toReversed();
    expect(exceptions).toEqual([
      'Error: The payload is not a job record (expected JSON with "job" and "data").',
      'Error: test.reset-link takes an encrypted payload (static encrypted), but this one is plain — not queued by this app.',
    ]);
    expect(application.seen.entries).toEqual([]);
  });

  it('fails an encrypted payload at once that is no ciphertext, or whose plaintext is no JSON', async () => {
    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    const encrypter = application.container.make((await import('@marmeon/encryption')).Encrypter);
    await push(application, driver, 'test.reset-link', { not: 'a string' }, { tries: 5, encrypted: true });
    await push(application, driver, 'test.reset-link', await encrypter.encrypt('hunter2-not-json', cipherContext('test.reset-link', 1)), { tries: 5, encrypted: true });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 2, failed: 2, released: 0 });
    expect(JSON.stringify(await failed.all())).not.toContain('hunter2');
    expect(application.seen.entries).toEqual([]);
  });

  it('holds an encrypted payload it cannot decrypt like a record of a newer release, and fails it after six hours without ever running it', async () => {
    await using application = await app();
    application.clock.freeze();
    const { driver, failed, worker: w } = worker(application);
    const id = await push(application, driver, 'test.reset-link', 'v1.garbage', { tries: 1, encrypted: true });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, released: 1, failed: 0 });
    expect(driver.entries()).toMatchObject([{ attempts: 0, availableAt: application.clock.now() + 15_000 }]);
    application.clock.travel({ hours: 6 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ released: 1, failed: 0 });
    application.clock.travel({ seconds: 301 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, failed: 1 });
    const [entry] = await failed.all();
    expect(entry).toMatchObject({ uuid: id, exception: expect.stringMatching(/^Error: \[marmeon:Q2\] The encrypted payload of test\.reset-link cannot be decrypted with APP_KEY or APP_PREVIOUS_KEYS.*No worker could run it within 6 hours/s) });
    expect(entry!.exception).not.toContain('garbage');
    expect(application.seen.entries).toEqual([]);
  });

  it('runs an encrypted payload another worker made under a key in APP_PREVIOUS_KEYS, and holds it where that key is unknown', async () => {
    const { AesGcmEncrypter, generateKey } = await import('@marmeon/encryption');
    const oldKey = generateKey();
    const newKey = generateKey();
    const decode = (key: string) => Buffer.from(key.replace('base64:', ''), 'base64');
    const data = await new AesGcmEncrypter(decode(oldKey)).encrypt(JSON.stringify({ email: 'a@b.c', token: 't' }), cipherContext('test.reset-link', 1));

    await using knows = await app({ env: { APP_KEY: newKey, APP_PREVIOUS_KEYS: oldKey } });
    const reader = worker(knows);
    await push(knows, reader.driver, 'test.reset-link', data, { encrypted: true });
    expect(await reader.worker.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, failed: 0, released: 0 });
    expect(knows.seen.entries).toHaveLength(1);

    await using ignorant = await app({ env: { APP_KEY: newKey } });
    const old = worker(ignorant);
    await push(ignorant, old.driver, 'test.reset-link', data, { encrypted: true });
    expect(await old.worker.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ released: 1, failed: 0 });
    expect(ignorant.seen.entries).toEqual([]);
  });

  it('holds a job it does not know, whatever its tries, and fails it once no worker took it in six hours (a rolling deploy)', async () => {
    await using application = await app();
    application.clock.freeze();
    const { driver, failed, worker: w } = worker(application);
    const id = await push(application, driver, 'test.from-the-next-release', {}, { tries: 1 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, released: 1, failed: 0 });
    // The attempt is given back: waiting for a worker that knows the job does not use up its tries.
    expect(driver.entries()).toMatchObject([{ attempts: 0, availableAt: application.clock.now() + 15_000 }]);
    application.clock.travel({ hours: 6 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ released: 1, failed: 0 });
    application.clock.travel({ seconds: 301 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, failed: 1 });
    expect(await failed.all()).toMatchObject([{ uuid: id, job: 'test.from-the-next-release', exception: expect.stringMatching(/^Error: \[marmeon:Q2\] No job named "test\.from-the-next-release" is registered in this app.*No worker could run it within 6 hours/s) }]);
  });

  it('traces an attempt that cannot run on queue.job — a job held for a worker that knows it, a poisoned payload — ending with its error, its log in the job\'s context', async () => {
    const lines: { message: string; context: Record<string, unknown> }[] = [];
    const logger: Logger = { debug() {}, info() {}, warn: (message, context = {}) => void lines.push({ message, context: { ...currentLogContext(), ...context } }), error: (message, context = {}) => void lines.push({ message, context: { ...currentLogContext(), ...context } }), child: () => logger };
    await using application = await app({ logger });
    application.clock.freeze();
    const driver = new MemoryQueueDriver({ clock: application.container.make(Clock) });
    const failed = new MemoryFailedJobStore();
    const container = application.container;
    const runner = new JobRunner(container, container.make(JobRegistry), async () => container.make((await import('@marmeon/encryption')).Encrypter));
    const w = new Worker({ driver, connection: 'memory', runner, failed, clock: container.make(Clock), logger });
    const ended: QueueJobMessage[] = [];
    const off = channels.subscribe(application, 'queue.job', { end: (message) => void ended.push(message) });
    try {
      const unknown = await push(application, driver, 'test.from-the-next-release', { token: 't0k3n' }, { tries: 2, backoff: [0], requestId: 'req-9' });
      const poisoned = await push(application, driver, 'test.reset-link', { email: 'a@b.c', token: 't' });
      expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 2, released: 1, failed: 1 });
      expect(ended.map(({ job, jobId, attempt, originRequestId, payload, error }) => ({ job, jobId, attempt, originRequestId, payload, error: (error as Error).message.split(' (')[0] }))).toEqual([
        { job: 'test.from-the-next-release', jobId: unknown, attempt: 1, originRequestId: 'req-9', payload: { token: 't0k3n' }, error: 'No job named "test.from-the-next-release" is registered in this app' },
        { job: 'test.reset-link', jobId: poisoned, attempt: 1, originRequestId: undefined, payload: { email: 'a@b.c', token: 't' }, error: expect.stringMatching(/^test\.reset-link takes an encrypted payload/) },
      ]);
      // The worker's lines about it carry the job's context — what the recorder files them under.
      expect(lines.map(({ context }) => context.jobId)).toEqual([unknown, poisoned]);
    } finally {
      off();
    }
    expect(await failed.all()).toHaveLength(1);
  });

  it('names a queue nobody takes — jobs ready at two looks in a row, none running — once, as a warning (a worker without --queue=mail)', async () => {
    const warnings: string[] = [];
    let named!: () => void;
    const warned = new Promise<void>((resolve) => (named = resolve));
    const logger: Logger = { debug() {}, info() {}, error() {}, warn: (message) => void (warnings.push(message), named()), child: () => logger };
    await using application = await app({ logger });
    const driver = new MemoryQueueDriver({ clock: application.container.make(Clock) });
    const container = application.container;
    const runner = new JobRunner(container, container.make(JobRegistry), async () => container.make((await import('@marmeon/encryption')).Encrypter));
    const w = new Worker({ driver, connection: 'memory', runner, failed: new MemoryFailedJobStore(), clock: container.make(Clock), logger });
    const job = (queue: string) => driver.push(queue, JSON.stringify({ v: 1, uuid: crypto.randomUUID(), job: 'test.welcome', data: { userId: 1 }, tries: 1, backoff: [], dispatchedAt: 0 }), 0);
    await job('mail');
    await job('mail');
    // A queue another worker takes: its job is running (claimed) — not named.
    await job('reports');
    await job('reports');
    await driver.reserve(['reports']);
    const stop = new AbortController();
    const run = w.run({ queues: ['default'], sleep: 0.005, watchOtherQueues: 0.02, signal: stop.signal });
    await Promise.race([warned, new Promise((resolve) => setTimeout(resolve, 3000))]);
    // A few more looks: still once.
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop.abort();
    await run;
    expect(warnings).toEqual([
      'Jobs are waiting on the "mail" queue of the memory connection, which this worker does not take (it takes default). If no other worker takes it, start this one without --queue (a worker without --queue takes every queue) or with --queue=mail,default (in priority order).',
    ]);
    // `false` never looks (the mail jobs still wait).
    warnings.length = 0;
    const quiet = new Worker({ driver, connection: 'memory', runner, failed: new MemoryFailedJobStore(), clock: container.make(Clock), logger });
    const halt = new AbortController();
    const running = quiet.run({ queues: ['default'], sleep: 0.005, watchOtherQueues: false, signal: halt.signal });
    await new Promise((resolve) => setTimeout(resolve, 80));
    halt.abort();
    await running;
    expect(warnings).toEqual([]);
    expect(await driver.size('mail')).toBe(2);
  });

  it('without queues takes every queue in one claim per round — an idle round asks the driver once, never for its list', async () => {
    await using application = await app();
    const memory = new MemoryQueueDriver({ clock: application.container.make(Clock) });
    const calls: string[] = [];
    const driver = new Proxy(memory, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => (calls.push(String(key)), (value as (...a: unknown[]) => unknown).apply(target, args));
      },
    });
    const { worker: w } = worker(application, driver);
    for (const queue of ['default', 'mail', 'reports']) await driver.push(queue, 'later', 60);
    calls.length = 0;
    expect(await w.run({ stopWhenEmpty: true })).toMatchObject({ processed: 0, reason: 'empty' });
    expect(calls, 'driver calls of an idle round without queues').toEqual(['reserveAny']);
    calls.length = 0;
    await w.run({ queues: ['*'], stopWhenEmpty: true });
    expect(calls, "driver calls of an idle round with ['*']").toEqual(['reserveAny']);
    calls.length = 0;
    await w.run({ queues: ['mail', '*'], stopWhenEmpty: true });
    expect(calls, "driver calls of an idle round with ['mail', '*']").toEqual(['reserve', 'reserveAny']);
    // Idle for a while: a worker on every queue never looks at "the other queues" — there are none.
    calls.length = 0;
    const stop = new AbortController();
    const running = w.run({ sleep: 0.005, watchOtherQueues: 0.01, signal: stop.signal });
    await sleep(80);
    stop.abort();
    await running;
    expect([...new Set(calls)], 'driver calls of an idle worker without queues').toEqual(['reserveAny']);
  });

  it('goes round the queues itself for a driver without reserveAny — the one after the queue it took from last first', async () => {
    await using application = await app();
    const memory = new MemoryQueueDriver({ clock: application.container.make(Clock) });
    // A driver without the optional reserveAny.
    const driver = new Proxy(memory, {
      get: (target, key) => {
        const value = Reflect.get(target, key) as unknown;
        return key === 'reserveAny' ? undefined : typeof value === 'function' ? value.bind(target) : value;
      },
    }) as QueueDriver;
    const job = (queue: string, userId: number) => driver.push(queue, JSON.stringify({ v: 1, uuid: crypto.randomUUID(), job: 'test.welcome', data: { userId }, tries: 1, backoff: [], dispatchedAt: 0 }), 0);
    for (const userId of [1, 2, 3]) await job('default', userId);
    await job('mail', 100);
    const { worker: w } = worker(application, driver as MemoryQueueDriver);
    expect(await w.run({ stopWhenEmpty: true })).toMatchObject({ processed: 4 });
    expect(application.seen.entries.map((entry) => (entry.payload as { userId: number }).userId), 'the order a worker without reserveAny took them').toEqual([1, 100, 2, 3]);
  });

  it('fails a job that came back more often than its tries (its worker died each time) instead of running it again', async () => {
    await using application = await app();
    application.clock.freeze();
    const driver = new MemoryQueueDriver({ clock: application.clock, retryAfterSeconds: 60 });
    const { failed, worker: w } = worker(application, driver);
    await push(application, driver, 'test.welcome', { userId: 1 }, { tries: 1 });
    await driver.reserve(['default']); // a worker that dies
    application.clock.travel({ seconds: 60 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, failed: 1 });
    expect((await failed.all())[0]!.exception).toMatch(/test\.welcome has been attempted 1 times without finishing/);
    expect(application.seen.entries).toEqual([]);
  });

  it('aborts job.signal at the timeout; a job that stops counts the attempt as failed (timed out)', async () => {
    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    await push(application, driver, 'test.polite-slow', {}, { tries: 1 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true, stopTimeout: 1 })).toMatchObject({ failed: 1 });
    expect((await failed.all())[0]!.exception).toMatch(/^JobTimeoutError: test\.polite-slow timed out after 0\.1s/);
  });

  it('gives up on a job that ignores its timeout and the grace period — the claim stays, for retryAfterSeconds', async () => {
    await using application = await app();
    const { driver, worker: w } = worker(application);
    await push(application, driver, 'test.rude-slow', {});
    let stuck: unknown;
    await expect(
      w.run({
        queues: ['default'],
        stopWhenEmpty: true,
        stopTimeout: 0.1,
        onStuck: (_job, error) => {
          stuck = error;
        },
      }),
    ).rejects.toThrow(JobStuckError);
    expect(String(stuck)).toMatch(/test\.rude-slow ignored its timeout of 0\.1s and did not stop within 0\.1s more/);
    expect(driver.entries()).toMatchObject([{ reserved: true, attempts: 1 }]);
  });

  it('when asked to stop, lets the running job finish, then claims nothing more', async () => {
    await using application = await app();
    const { driver, worker: w } = worker(application);
    await push(application, driver, 'test.welcome', { userId: 1 });
    await push(application, driver, 'test.welcome', { userId: 2 });
    const stop = new AbortController();
    stop.abort();
    expect(await w.run({ queues: ['default'], signal: stop.signal })).toMatchObject({ processed: 0, reason: 'stopped' });
    expect(driver.entries()).toHaveLength(2);
  });

  it('when asked to stop, releases a job that does not finish within the stop timeout, its attempt given back', async () => {
    await using application = await app();
    const { driver, worker: w } = worker(application);
    await push(application, driver, 'test.rude-slow', {});
    const stop = new AbortController();
    const running = w.run({ queues: ['default'], signal: stop.signal, stopTimeout: 0.05 });
    await sleep(20);
    stop.abort();
    expect(await running).toMatchObject({ reason: 'interrupted' });
    expect(driver.entries()).toMatchObject([{ reserved: false, attempts: 0 }]);
  });

  it('refuses to start when retryAfterSeconds does not cover a job timeout plus the stop timeout', () => {
    const registry = new JobRegistry().add([WelcomeJob, PoliteSlowJob], 'module test');
    expect(() => checkTimeouts(registry, 'database', 70, 10)).toThrow(QueueSetupError);
    expect(() => checkTimeouts(registry, 'database', 70, 10)).toThrow('[marmeon:Q4] The queue connection "database"');
    expect(() => checkTimeouts(registry, 'database', 70, 10)).toThrow(
      'The queue connection "database" gives a claimed job 70s (retryAfterSeconds) before another worker may take it, but test.welcome (timeout 60s) may hold it for its timeout plus the worker\'s --stop-timeout of 10s — a second worker would run it while the first still does. Raise retryAfterSeconds (e.g. QUEUE_DATABASE_RETRY_AFTER_SECONDS) above timeout + stop timeout, or lower the job\'s static timeout.',
    );
    expect(() => checkTimeouts(registry, 'database', 71, 10)).not.toThrow();
  });
});

describe('the QueueFake', () => {
  it('records dispatches (checked like real ones), asserts on them, and runs them for real on work()', async () => {
    await using application = await app();
    const fake = new QueueFake(application.container);
    application.clock.freeze();
    fake.assertNothingDispatched();
    await fake.dispatch(WelcomeJob, { userId: 7 }, { queue: 'mail' });
    await fake.dispatch(FlakyJob, { failUntil: 2 });
    await expect(fake.dispatch(WelcomeJob, { userId: 'x' } as never)).rejects.toThrow(JobPayloadError);

    fake.assertDispatched(WelcomeJob).assertDispatched(WelcomeJob, { userId: 7 }).assertDispatched(WelcomeJob, (payload, job) => payload.userId > 5 && job.queue === 'mail');
    fake.assertDispatchedTimes(WelcomeJob, 1).assertNotDispatched(WelcomeJob, { userId: 8 }).assertNotDispatched(ChoosyJob);
    expect(() => fake.assertDispatched(WelcomeJob, { userId: 8 })).toThrow(/Expected WelcomeJob \(test\.welcome\) to be dispatched matching the given payload\. Dispatched: WelcomeJob \{"userId":7\}; FlakyJob \{"failUntil":2\}\./);
    expect(() => fake.assertNothingDispatched()).toThrow(/Expected no job to be dispatched/);
    expect(application.seen.entries).toEqual([]);

    expect(await fake.work()).toMatchObject({ processed: 2, released: 1 });
    expect(application.seen.entries.map((entry) => entry.job)).toEqual(['test.welcome', 'test.flaky']);
    application.clock.travel({ seconds: 10 });
    expect(await fake.work()).toMatchObject({ processed: 1, released: 0, failed: 0 });
    expect(await fake.failed()).toEqual([]);
    expect(fake.pending()).toEqual([]);
  });

  it('stands in for the Queue in a transaction too', async () => {
    await using application = await app();
    const fake = new QueueFake(application.container);
    const db = application.container.make(Connections).get();
    await db.transaction().execute((trx) => fake.using(trx).dispatch(WelcomeJob, { userId: 1 }));
    expect(fake.dispatched(WelcomeJob)).toMatchObject([{ payload: { userId: 1 }, inTransaction: true }]);
  });

  it('refuses a unique job, and a sync one, through a transaction the app began itself like the Queue', async () => {
    await using application = await app();
    const fake = new QueueFake(application.container);
    const db = application.container.make(Connections).get();
    await expect(db.transaction().execute((trx) => fake.using(trx).dispatch(WelcomeJob, { userId: 1 }, { unique: 'welcome' }))).rejects.toThrow(/unique job cannot follow a transaction you began yourself/);
    await using synced = await app({ env: { QUEUE_DRIVER: 'sync' } });
    const syncFake = new QueueFake(synced.container);
    const syncDb = synced.container.make(Connections).get();
    await expect(syncDb.transaction().execute((trx) => syncFake.using(trx).dispatch(WelcomeJob, { userId: 1 }))).rejects.toThrow(/sync queue cannot run a job for a transaction you began yourself/);
    expect(fake.dispatched(WelcomeJob)).toEqual([]);
  });
});

// Type guarantees — checked by the build, never run.
export function typeChecks(queue: Queue): void {
  void queue.dispatch(WelcomeJob, { userId: 1 });
  void queue.dispatch(WelcomeJob, { userId: 1 }, { delay: { minutes: 5 }, queue: 'mail' });
  void queue.bulk([
    [WelcomeJob, { userId: 1 }],
    [FlakyJob, { failUntil: 2 }],
  ]);
  // @ts-expect-error — the payload comes from the schema
  void queue.dispatch(WelcomeJob, { userId: 'x' });
  // @ts-expect-error — a missing field
  void queue.dispatch(WelcomeJob, {});
  // @ts-expect-error — in a bulk list too
  void queue.bulk([[WelcomeJob, { userId: 'x' }]]);

  class NotAJob {
    handle() {}
  }
  // @ts-expect-error — the connection is an option: size('mail', { connection: 'redis' })
  void queue.size('mail', 'redis');
  void queue.size('mail', { connection: 'redis' });

  // @ts-expect-error — no static job / schema
  void queue.dispatch(NotAJob, {});

  class WrongHandle {
    static readonly job = 'test.wrong-handle';
    static readonly schema = v.object({ userId: v.number() });
    handle(_payload: { userId: string }) {}
  }
  // @ts-expect-error — handle() takes another payload than the schema yields
  void queue.dispatch(WrongHandle, { userId: 1 });

  class DateJob {
    static readonly job = 'test.date';
    static readonly schema = v.object({ at: v.date() });
    handle() {}
  }
  // @ts-expect-error — a Date is not JSON
  void queue.dispatch(DateJob, { at: new Date() });

  class NullableJob {
    static readonly job = 'test.nullable';
    static readonly schema = v.object({ user: v.nullable(v.object({ id: v.number() })), tags: v.optional(v.array(v.string())) });
    handle() {}
  }
  void queue.dispatch(NullableJob, { user: null });
}

const FORMATS = new URL('./__fixtures__/formats/', import.meta.url);
const fixtures = (format: string) => readdirSync(new URL(`${format}/`, FORMATS)).map((name) => ({ name, text: readFileSync(new URL(`${format}/${name}`, FORMATS), 'utf8') }));

describe('the version of the job record', () => {
  /** Reads a version 2 as a version 1 — what a later release's reader does for the version it replaces. */
  async function withSyntheticReader<T>(run: () => Promise<T> | T): Promise<T> {
    RECORD_READERS[2] = (value, depth) => RECORD_READERS[1]!({ ...value, v: 1 }, depth);
    try {
      return await run();
    } finally {
      delete RECORD_READERS[2];
    }
  }
  const raw = (driver: MemoryQueueDriver, record: Record<string, unknown>) => driver.push('default', JSON.stringify(record), 0);
  const base = (application: Application, extra: Record<string, unknown> = {}) => ({ uuid: crypto.randomUUID(), job: 'test.welcome', data: { userId: 1 }, tries: 3, backoff: [], dispatchedAt: application.container.make(Clock).now(), ...extra });

  it('reads every fixture of the format and runs it', async () => {
    const files = fixtures('job-record');
    expect(files.map(({ name }) => name)).toContain('v1.json');
    for (const { name, text } of files) expect(parseRecord(text), name).toMatchObject({ kind: 'record', record: { v: 1 } });
    const parsed = (name: string) => (parseRecord(files.find((file) => file.name === name)!.text) as { record: { chain?: unknown[]; unique?: unknown; encrypted?: true; fromReporter?: true } }).record;
    expect(parsed('v1-chain.json').chain).toHaveLength(2);
    expect(parsed('v1-unique.json').unique).toMatchObject({ until: 'processing' });
    expect(parsed('v1-encrypted.json').encrypted).toBe(true);
    expect(parsed('v1-from-reporter.json')).toMatchObject({ fromReporter: true });
    expect(parsed('v1.json')).not.toHaveProperty('fromReporter');

    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    for (const { text } of files) await driver.push('default', text, 0);
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 7, failed: 0, released: 0 });
    expect(await failed.all()).toEqual([]);
    expect(driver.entries()).toEqual([]);
    expect(application.seen.entries.map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([{ userId: 7 }, { userId: 1 }, { userId: 2 }, { userId: 3 }, { userId: 4 }, { email: 'ada@example.com', token: 'reset-token' }]),
    );
  });

  it('reads the member of the redis driver around the payload it does not look into', () => {
    const text = fixtures('redis-member')[0]!.text;
    const member = parseMember(text);
    expect(member).toMatchObject({ id: '5b0e1c2a-7d3f-4e9b-8a61-2c4d6e8f0a13', attempts: 1 });
    expect(parseRecord(member.payload)).toMatchObject({ kind: 'record', record: { job: 'test.welcome' } });
  });

  it('writes the version on every record it queues — also on the links of a chain', async () => {
    await using application = await app();
    const queue = application.container.make(Queue);
    await queue.chain([[WelcomeJob, { userId: 1 }], [WelcomeJob, { userId: 2 }]]);
    const rows = (await sql<{ payload: string }>`select payload from jobs`.execute(application.container.make(Connections).get())).rows;
    const record = JSON.parse(rows[0]!.payload);
    expect([record.v, record.chain[0].v]).toEqual([1, 1]);
  });

  it('names a chain link without a version without a second code in the middle of the message', () => {
    const link = { uuid: 'l', job: 'test.welcome', data: {}, dispatchedAt: 5 };
    const parsed = parseRecord(JSON.stringify({ uuid: 'u', job: 'test.welcome', data: {}, dispatchedAt: 5, v: 1, chain: [link] }));
    expect(parsed).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/^Link 1 of the record's chain cannot be read — The record was queued by a release before/) });
    expect((parsed as { reason: string }).reason).not.toContain('[marmeon:');
  });

  it('keeps one reader per version: a registered version 2 is read next to 1, a version 3 is foreign', async () => {
    const text = (value: unknown) => JSON.stringify({ uuid: 'u', job: 'test.welcome', data: {}, dispatchedAt: 5, v: value });
    expect(parseRecord(text(2)).kind).toBe('foreign');
    await withSyntheticReader(() => {
      expect(parseRecord(text(1)).kind).toBe('record');
      expect(parseRecord(text(2))).toMatchObject({ kind: 'record', record: { v: 1 } });
      expect(parseRecord(text(3))).toMatchObject({ kind: 'foreign', envelope: { v: 3, uuid: 'u', job: 'test.welcome', dispatchedAt: 5 } });
    });
  });

  it('holds a record of a newer version: it never runs, the attempt is given back, the pause grows with its age', async () => {
    await using application = await app();
    application.clock.freeze();
    const { driver, failed, worker: w } = worker(application);
    const now = application.clock.now();
    const id = crypto.randomUUID();
    await raw(driver, base(application, { v: 2, uuid: id, tries: 1, dispatchedAt: now - 400_000, restriction: 'only-for-admins' }));
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, released: 1, failed: 0 });
    expect(driver.entries()).toMatchObject([{ attempts: 0, availableAt: now + 100_000 }]);
    application.clock.travel({ seconds: 100 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ released: 1 });
    // Older again: a longer pause, at most five minutes.
    application.clock.travel({ hours: 3 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ released: 1 });
    expect(driver.entries()).toMatchObject([{ attempts: 0, availableAt: application.clock.now() + 300_000 }]);
    expect(application.seen.entries).toEqual([]);
    expect(await failed.all()).toEqual([]);
    // Six hours after it was dispatched nobody took it: failed with its reason and its payload, under its own id.
    application.clock.travel({ hours: 4 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ failed: 1 });
    const [entry] = await failed.all();
    expect(entry).toMatchObject({ uuid: id, job: 'test.welcome', exception: expect.stringMatching(/^Error: \[marmeon:Q2\] .*version 2.*No worker could run it within 6 hours/s) });
    expect(JSON.parse(entry!.payload)).toMatchObject({ v: 2, restriction: 'only-for-admins' });
    expect(application.seen.entries).toEqual([]);
  });

  it('stamps a job released with a backoff, so a worker that cannot read it yet holds it instead of failing it', async () => {
    await using application = await app();
    application.clock.freeze();
    const { driver, failed, worker: w } = worker(application);
    const now = application.clock.now();
    const hours = 8 * 3600;
    // Dispatched long ago and retried with a backoff of eight hours.
    await push(application, driver, 'test.flaky', { failUntil: 9 }, { tries: 3, backoff: [hours], dispatchedAt: now - 20 * 3_600_000 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ released: 1 });
    expect(JSON.parse(driver.entries()[0]!.payload).availableAt).toBe(now + hours * 1000);
    application.clock.travel({ seconds: hours });
    // The next worker is of a release that does not know the job: the time it waited is counted from the end of the backoff.
    const entry = driver.entries()[0]!;
    const unknown = JSON.stringify({ ...JSON.parse(entry.payload), job: 'test.from-the-next-release' });
    const other = worker(application);
    await other.driver.push('default', unknown, 0);
    expect(await other.worker.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ released: 1, failed: 0 });
    expect(await failed.all()).toEqual([]);
    expect(await other.failed.all()).toEqual([]);
  });

  it('runs a held record once a worker reads its version', async () => {
    await using application = await app();
    application.clock.freeze();
    const { driver, failed, worker: w } = worker(application);
    await raw(driver, base(application, { v: 2 }));
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ released: 1 });
    application.clock.travel({ seconds: 15 });
    await withSyntheticReader(async () => {
      expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, released: 0, failed: 0 });
    });
    expect(application.seen.entries).toHaveLength(1);
    expect(await failed.all()).toEqual([]);
  });

  it('fails a newer record whose dispatch time cannot be read at once — it cannot be held for six hours', async () => {
    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    await raw(driver, { v: 2, uuid: crypto.randomUUID(), job: 'test.welcome', data: {}, dispatchedAt: 'yesterday' });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ failed: 1, released: 0 });
    expect((await failed.all())[0]!.exception).toMatch(/dispatch time cannot be read/);
  });

  it('holds a job it does not know, or one whose payload its schema rejects (a newer enum member), however few tries it has — and warns once', async () => {
    const lines: string[] = [];
    const logger: Logger = { debug() {}, info() {}, error() {}, warn: (message) => void lines.push(message), child: () => logger };
    await using application = await app({ logger });
    application.clock.freeze();
    const driver = new MemoryQueueDriver({ clock: application.container.make(Clock) });
    const failed = new MemoryFailedJobStore();
    const container = application.container;
    const runner = new JobRunner(container, container.make(JobRegistry), async () => container.make((await import('@marmeon/encryption')).Encrypter));
    const w = new Worker({ driver, connection: 'memory', runner, failed, clock: container.make(Clock), logger });
    await push(application, driver, 'test.choosy', { choice: 'archive' }, { tries: 1 });
    await push(application, driver, 'test.not-here', {}, { tries: 1 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 2, released: 2, failed: 0 });
    application.clock.travel({ seconds: 60 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ released: 2 });
    expect(driver.entries()).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith('Holding'))).toHaveLength(2);
    expect(lines.find((line) => line.startsWith('Holding test.choosy'))).toContain('no longer matches the schema');
    expect(await failed.all()).toEqual([]);
  });

  it('fails a record without a version at once, with the reason and its payload — it never runs', async () => {
    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    const record = base(application, { tries: 5 });
    await raw(driver, record);
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, failed: 1, released: 0 });
    const [entry] = await failed.all();
    expect(entry!.exception).toMatch(/^Error: \[marmeon:Q1\] .*before job records carried a version.*docs\/queues\.md#deploying-while-jobs-wait/s);
    expect(JSON.parse(entry!.payload)).toEqual(record);
    expect(entry).toMatchObject({ uuid: record.uuid, job: 'test.welcome' });
    expect(application.seen.entries).toEqual([]);
    expect(driver.entries()).toEqual([]);
  });

  it.each([['"1"', '1'], ['1.5', 1.5], ['-1', -1], ['0', 0], ['null', null], ['true', true], ['a huge number', 1e300]])('never runs a record whose version is %s', async (_label, version) => {
    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    await raw(driver, base(application, { v: version, tries: 5 }));
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ failed: 1, released: 0 });
    expect((await failed.all())[0]!.exception).toMatch(/not a positive integer/);
    expect(application.seen.entries).toEqual([]);
  });

  it('fails a record whose chain has a link it cannot read, and runs no part of the chain', async () => {
    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    for (const link of [{ job: 'test.welcome', data: { userId: 2 } }, { v: 'x', job: 'test.welcome', data: { userId: 2 } }, 'a string']) {
      await raw(driver, { ...base(application, { v: 1 }), chain: [link] });
    }
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 3, failed: 3, released: 0 });
    expect((await failed.all()).map((job) => job.exception.split('\n')[0])).toEqual(expect.arrayContaining([expect.stringMatching(/^Error: Link 1 of the record's chain cannot be read/)]));
    expect(application.seen.entries).toEqual([]);
  });

  it('reads an unknown "until" of a unique lock as "done" — the lock is held longer, never shorter', () => {
    const record = { v: 1, uuid: 'u', job: 'test.welcome', data: {}, unique: { lock: 'l', key: 'k', for: 60, until: 'later' } };
    expect(parseRecord(JSON.stringify(record))).toMatchObject({ kind: 'record', record: { unique: { until: 'done' } } });
  });

  it('still gives up on a job that comes back more often than it has tries (its worker dies during each attempt)', async () => {
    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    const payload = JSON.stringify(base(application, { v: 1, tries: 2 }));
    expect(await w.process({ id: 'x', queue: 'default', payload, attempts: 3, reservedAt: 0 })).toBe('failed');
    expect((await failed.all())[0]!.exception).toMatch(/attempted 2 times without finishing/);
    expect(application.seen.entries).toEqual([]);
    expect(driver.entries()).toEqual([]);
  });

  it('tells a listener of each hold: JobReleased with reason "unknown", the pause and the attempt', async () => {
    await using application = await app();
    application.clock.freeze();
    const driver = new MemoryQueueDriver({ clock: application.container.make(Clock) });
    const container = application.container;
    const runner = new JobRunner(container, container.make(JobRegistry), async () => container.make((await import('@marmeon/encryption')).Encrypter));
    const events: JobEvent[] = [];
    const w = new Worker({ driver, connection: 'memory', runner, failed: new MemoryFailedJobStore(), clock: container.make(Clock), logger: silent, events: async (event) => void events.push(event) });
    const now = application.clock.now();
    const id = crypto.randomUUID();
    await raw(driver, base(application, { v: 2, uuid: id, dispatchedAt: now - 400_000 }));
    await w.run({ queues: ['default'], stopWhenEmpty: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(JobReleased);
    expect(events[0]).toMatchObject({ jobId: id, job: 'test.welcome', queue: 'default', connection: 'memory', reason: 'unknown', delaySeconds: 100, attempt: 1 });
  });

  it('counts the time a record is held from when it could be claimed: a delay over six hours, a late link of a chain, a retried job', async () => {
    await using application = await app();
    application.clock.freeze();
    const { driver, failed, worker: w } = worker(application);
    const now = application.clock.now();
    // Dispatched seven hours ago for now (a delay), or put back on the queue now: not old yet.
    await raw(driver, base(application, { v: 2, dispatchedAt: now - 7 * 3_600_000, availableAt: now }));
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ released: 1, failed: 0 });
    // Without it the same record has waited seven hours.
    await raw(driver, base(application, { v: 2, dispatchedAt: now - 7 * 3_600_000 }));
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ failed: 1 });
    expect(await failed.all()).toHaveLength(1);
  });

  it('stamps the time a record could first be claimed: at the push (with its delay), for the next link of a chain', async () => {
    await using application = await app();
    application.clock.freeze();
    const queue = application.container.make(Queue);
    const now = application.clock.now();
    await queue.dispatch(WelcomeJob, { userId: 1 }, { delay: 7200 });
    await queue.chain([[WelcomeJob, { userId: 2 }], [WelcomeJob, { userId: 3 }]]);
    const { rows } = await sql<{ payload: string }>`select payload from jobs order by id`.execute(application.container.make(Connections).get());
    expect(rows.map((row) => JSON.parse(row.payload).availableAt)).toEqual([now + 7_200_000, now]);
    const head = parseRecord(rows[1]!.payload) as { record: JobRecord };
    expect(JSON.parse(nextInChain(head.record, now + 5)!)).toMatchObject({ job: 'test.welcome', data: { userId: 3 }, availableAt: now + 5 });
  });

  it('fails a newer record at once whose dispatch or availability lies more than five minutes ahead of the clock, or that has no id', async () => {
    await using application = await app();
    application.clock.freeze();
    const { driver, failed, worker: w } = worker(application);
    const now = application.clock.now();
    await raw(driver, base(application, { v: 2, dispatchedAt: now + 10 * 60_000 }));
    await raw(driver, base(application, { v: 2, availableAt: now + 10 * 60_000 }));
    await raw(driver, { v: 2, job: 'test.welcome', data: {}, dispatchedAt: now });
    await raw(driver, base(application, { v: 2, dispatchedAt: now + 60_000 }));
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 4, failed: 3, released: 1 });
    expect((await failed.all()).map((job) => job.exception.split('\n')[0]).toReversed()).toEqual([
      expect.stringMatching(/dispatch time cannot be read/),
      expect.stringMatching(/dispatch time cannot be read/),
      expect.stringMatching(/no readable id/),
    ]);
  });

  it('labels the failure of a record without a version with the id and name it claims, tells JobFailed and frees its unique lock only when it names one', async () => {
    await using application = await app();
    const driver = new MemoryQueueDriver({ clock: application.container.make(Clock) });
    const container = application.container;
    const runner = new JobRunner(container, container.make(JobRegistry), async () => container.make((await import('@marmeon/encryption')).Encrypter));
    const events: JobEvent[] = [];
    const failed = new MemoryFailedJobStore();
    const w = new Worker({ driver, connection: 'memory', runner, failed, clock: container.make(Clock), logger: silent, events: async (event) => void events.push(event) });
    const id = crypto.randomUUID();
    await raw(driver, base(application, { uuid: id, job: 'test.welcome' }));
    await driver.push('default', 'not json', 0);
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ failed: 2 });
    const rows = await failed.all();
    expect(rows.map((job) => job.job)).toEqual(['?', 'test.welcome']);
    expect(rows[1]!.uuid).toBe(id);
    expect(events.filter((event) => event instanceof JobFailed).map((event) => event.jobId)).toEqual([id, rows[0]!.uuid]);

    const unique = { lock: 'queue:unique:test.welcome:k', key: 'k', for: 60, until: 'done' };
    expect(parseRecord(JSON.stringify({ uuid: 'u', job: 'j', data: {}, unique }))).toMatchObject({ kind: 'invalid', identity: { uuid: 'u', job: 'j', unique } });
    expect(parseRecord(JSON.stringify({ uuid: 'u', job: 'j', data: {}, unique: { lock: 3 } }))).toMatchObject({ kind: 'invalid', identity: { uuid: 'u', job: 'j' } });
    expect((parseRecord(JSON.stringify({ uuid: 'u', job: 'j', data: {}, unique: { lock: 3 } })) as { identity: object }).identity).not.toHaveProperty('unique');
    expect(parseRecord('[1]')).toEqual({ kind: 'invalid', reason: expect.any(String) });
  });

  it('warns once about a job it holds, remembering the thousand newest', async () => {
    const lines: string[] = [];
    const logger: Logger = { debug() {}, info() {}, error() {}, warn: (message) => void lines.push(message), child: () => logger };
    await using application = await app({ logger });
    application.clock.freeze();
    const container = application.container;
    const runner = new JobRunner(container, container.make(JobRegistry), async () => container.make((await import('@marmeon/encryption')).Encrypter));
    const w = new Worker({ driver: new MemoryQueueDriver({ clock: container.make(Clock) }), connection: 'memory', runner, failed: new MemoryFailedJobStore(), clock: container.make(Clock), logger });
    const reserved = (n: number) => ({ id: `j${n}`, queue: 'default', attempts: 1, reservedAt: 0, payload: JSON.stringify(base(application, { v: 2, uuid: `u${n}` })) });
    for (let n = 1; n <= 1001; n++) await w.process(reserved(n));
    expect(lines).toHaveLength(1001);
    await w.process(reserved(1001));
    expect(lines).toHaveLength(1001);
    // The oldest was forgotten for the newest, so it is told again.
    await w.process(reserved(1));
    expect(lines).toHaveLength(1002);
  });

  it('refuses a chain nested deeper than a thousand links', () => {
    let record: Record<string, unknown> = { v: 1, uuid: 'u', job: 'test.welcome', data: {} };
    for (let depth = 0; depth < 1001; depth++) record = { v: 1, uuid: 'u', job: 'test.welcome', data: {}, chain: [record] };
    expect(parseRecord(JSON.stringify(record))).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/chain is nested deeper than 1000/) });
    let shallow: Record<string, unknown> = { v: 1, uuid: 'u', job: 'test.welcome', data: {} };
    for (let depth = 0; depth < 50; depth++) shallow = { v: 1, uuid: 'u', job: 'test.welcome', data: {}, chain: [shallow] };
    expect(parseRecord(JSON.stringify(shallow)).kind).toBe('record');
  });

  it('fails a record instead of crashing when preparing it throws', async () => {
    await using application = await app();
    const driver = new MemoryQueueDriver({ clock: application.container.make(Clock) });
    const failed = new MemoryFailedJobStore();
    const runner = { prepare: async () => Promise.reject(new Error('the registry broke')) } as unknown as JobRunner;
    const w = new Worker({ driver, connection: 'memory', runner, failed, clock: application.container.make(Clock), logger: silent });
    expect(await w.process({ id: 'x', queue: 'default', payload: '{}', attempts: 1, reservedAt: 0 })).toBe('failed');
    expect((await failed.all())[0]!.exception).toMatch(/could not be prepared: the registry broke/);
  });

  it('binds an encrypted payload to the record version: under the context of no version it does not decrypt', async () => {
    expect(cipherContext('test.reset-link')).toBe('queue:v1:test.reset-link');
    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    const encrypter = application.container.make((await import('@marmeon/encryption')).Encrypter);
    const data = await encrypter.encrypt(JSON.stringify({ email: 'a@b.c', token: 't' }), 'queue:test.reset-link');
    await raw(driver, base(application, { v: 1, job: 'test.reset-link', data, encrypted: true }));
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ released: 1, failed: 0 });
    expect(await failed.all()).toEqual([]);
    expect(application.seen.entries).toEqual([]);
  });
});

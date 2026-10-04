import { setTimeout as sleep } from 'node:timers/promises';
import { Clock, createApplication, currentLogContext, Logger, TestClock, type Application, type ModuleDefinition } from '@bespokecore/core';
import { channels, type QueueJobMessage } from '@bespokecore/core/diagnostics';
import { Connections, DatabaseServiceProvider, sql } from '@bespokecore/database';
import { EncryptionServiceProvider } from '@bespokecore/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { migrate, silent } from './__fixtures__/targets.ts';
import { checkTimeouts } from './connections.ts';
import { MemoryFailedJobStore, MemoryQueueDriver } from './drivers/memory.ts';
import { QueueFake } from './fake.ts';
import { Queue, QueueServiceProvider, type JobContext, type JobPayload } from './index.ts';
import { JobRegistry, QueueSetupError } from './registry.ts';
import { JobPayloadError, JobRunner } from './runner.ts';
import { JobStuckError, Worker } from './worker.ts';

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

/** Something scoped: one per attempt (a job's scope), never shared between attempts. */
class UnitOfWork {
  readonly id = crypto.randomUUID();
}

/** What the jobs of this file saw — a test-only recorder, injected. */
class Seen {
  readonly entries: { job: string; payload: unknown; attempt: number; id: string; unit?: string; log?: Record<string, unknown> }[] = [];
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

/** Carries a secret: its payload is encrypted in the queue (E105). */
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

const allJobs = [WelcomeJob, FlakyJob, ChoosyJob, PoliteSlowJob, RudeSlowJob, ResetLinkJob];

/** A real app: database (SQLite in memory, migrated), queue, encryption — the jobs in one module. */
async function app(options: { env?: Record<string, string>; modules?: ModuleDefinition[]; clock?: TestClock; logger?: Logger } = {}): Promise<Application & { seen: Seen; clock: TestClock }> {
  const clock = options.clock ?? new TestClock();
  const seen = new Seen();
  const application = await createApplication({
    root: '/tmp',
    discover: false,
    env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY, ...options.env },
    providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider],
    modules: options.modules ?? [{ name: 'test', jobs: allJobs }],
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
  const runner = new JobRunner(container, container.make(JobRegistry), async () => container.make((await import('@bespokecore/encryption')).Encrypter));
  return { driver, failed, worker: new Worker({ driver, connection: 'memory', runner, failed, clock: container.make(Clock), logger: silent }) };
}

async function push(application: Application, driver: MemoryQueueDriver, job: string, data: unknown, extra: Record<string, unknown> = {}): Promise<string> {
  const uuid = crypto.randomUUID();
  await driver.push('default', JSON.stringify({ uuid, job, data, tries: 1, backoff: [], dispatchedAt: application.container.make(Clock).now(), ...extra }), 0);
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
      static readonly job = 'bespoke.mail';
      static readonly schema = v.object({});
      handle() {}
    }
    expect(() => registry.add([NoName as never], 'module x')).toThrow(/NoName \(module x\) needs a stable name: static job = 'module\.what-it-does'/);
    expect(() => registry.add([ClassName as never], 'module x')).toThrow(/"SendMail" is not one/);
    expect(() => registry.add([NoSchema as never], 'module x')).toThrow(/needs static schema/);
    expect(() => registry.add([NoHandle as never], 'module x')).toThrow(/needs a handle\(payload, job\) method/);
    expect(() => registry.add([Framework], 'module x')).toThrow(/names under "bespoke\." belong to the framework/);
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

  it('writes through a transaction: a rollback leaves no job (E85)', async () => {
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
    await using application = await app({ env: { QUEUE_CONNECTION: 'sync' } });
    const queue = application.container.make(Queue);
    await queue.dispatch(WelcomeJob, { userId: 3 });
    expect(application.seen.entries).toMatchObject([{ payload: { userId: 3 }, attempt: 1 }]);
    await expect(queue.dispatch(FlakyJob, { failUntil: 2 })).rejects.toThrow(/SMTP said no/);
    await expect(queue.dispatch(ChoosyJob, { choice: 'release' })).rejects.toThrow(/the sync connection runs a job only once/);
    await expect(queue.dispatch(ChoosyJob, { choice: 'fail' })).rejects.toThrow(/the account is gone/);
    await queue.dispatch(ChoosyJob, { choice: 'discard' });
    expect(await queue.size()).toBe(0);
  });

  it('encrypts the payload of a static encrypted job — no plaintext in jobs or failed_jobs (E105)', async () => {
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

  it('fails a payload that cannot run at once: no job record, a payload the schema rejects, a forged plaintext for an encrypted job, a ciphertext it cannot read', async () => {
    await using application = await app();
    const { driver, failed, worker: w } = worker(application);
    await driver.push('default', 'not json', 0);
    await push(application, driver, 'test.welcome', { userId: 'x' }, { tries: 5 });
    await push(application, driver, 'test.reset-link', { email: 'a@b.c', token: 't' }, { tries: 5 });
    await push(application, driver, 'test.reset-link', 'v1.garbage', { tries: 5, encrypted: true });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 4, failed: 4, released: 0 });
    const exceptions = (await failed.all()).map((job) => job.exception.split('\n')[0]).toReversed();
    expect(exceptions).toEqual([
      'Error: The payload is not a job record (expected JSON with "job" and "data").',
      'Error: The payload no longer matches the schema of test.welcome: userId: Invalid type: Expected number but received "x"',
      'Error: test.reset-link takes an encrypted payload (static encrypted), but this one is plain — not queued by this app.',
      expect.stringMatching(/^Error: The encrypted payload of test\.reset-link cannot be decrypted \(was APP_KEY changed\?\)/),
    ]);
    expect(application.seen.entries).toEqual([]);
  });

  it('releases a job it does not know with the backoff it was dispatched with (a rolling deploy), then fails it', async () => {
    await using application = await app();
    application.clock.freeze();
    const { driver, failed, worker: w } = worker(application);
    await push(application, driver, 'test.from-the-next-release', {}, { tries: 2, backoff: [20] });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, released: 1 });
    application.clock.travel({ seconds: 20 });
    expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 1, failed: 1 });
    expect((await failed.all())[0]!.exception).toMatch(/^Error: No job named "test\.from-the-next-release" is registered in this app/);
  });

  it('traces an attempt that cannot run on queue.job — an unknown name, a poisoned payload — ending with its error, its log in the job\'s context (W7.11)', async () => {
    const lines: { message: string; context: Record<string, unknown> }[] = [];
    const logger: Logger = { debug() {}, info() {}, warn: (message, context = {}) => void lines.push({ message, context: { ...currentLogContext(), ...context } }), error: (message, context = {}) => void lines.push({ message, context: { ...currentLogContext(), ...context } }), child: () => logger };
    await using application = await app({ logger });
    application.clock.freeze();
    const driver = new MemoryQueueDriver({ clock: application.container.make(Clock) });
    const failed = new MemoryFailedJobStore();
    const container = application.container;
    const runner = new JobRunner(container, container.make(JobRegistry), async () => container.make((await import('@bespokecore/encryption')).Encrypter));
    const w = new Worker({ driver, connection: 'memory', runner, failed, clock: container.make(Clock), logger });
    const ended: QueueJobMessage[] = [];
    const off = channels.subscribe(application, 'queue.job', { end: (message) => void ended.push(message) });
    try {
      const unknown = await push(application, driver, 'test.from-the-next-release', { token: 't0k3n' }, { tries: 2, backoff: [0], requestId: 'req-9' });
      const poisoned = await push(application, driver, 'test.welcome', { userId: 'x' });
      expect(await w.run({ queues: ['default'], stopWhenEmpty: true })).toMatchObject({ processed: 3, released: 1, failed: 2 });
      expect(ended.map(({ job, jobId, attempt, originRequestId, payload, error }) => ({ job, jobId, attempt, originRequestId, payload, error: (error as Error).message.split(' (')[0] }))).toEqual([
        { job: 'test.from-the-next-release', jobId: unknown, attempt: 1, originRequestId: 'req-9', payload: { token: 't0k3n' }, error: 'No job named "test.from-the-next-release" is registered in this app' },
        { job: 'test.from-the-next-release', jobId: unknown, attempt: 2, originRequestId: 'req-9', payload: { token: 't0k3n' }, error: 'No job named "test.from-the-next-release" is registered in this app' },
        { job: 'test.welcome', jobId: poisoned, attempt: 1, originRequestId: undefined, payload: { userId: 'x' }, error: expect.stringMatching(/^The payload no longer matches the schema of test\.welcome/) },
      ]);
      // The worker's lines about it carry the job's context — what the recorder files them under.
      expect(lines.map(({ context }) => context.jobId)).toEqual([unknown, unknown, poisoned]);
    } finally {
      off();
    }
    expect(await failed.all()).toHaveLength(2);
  });

  it('fails a job that came back more often than its tries (its worker died each time) instead of running it again', async () => {
    await using application = await app();
    application.clock.freeze();
    const driver = new MemoryQueueDriver({ clock: application.clock, retryAfter: 60 });
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

  it('gives up on a job that ignores its timeout and the grace period — the claim stays, for retryAfter', async () => {
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

  it('when asked to stop, releases a job that does not finish within the stop timeout', async () => {
    await using application = await app();
    const { driver, worker: w } = worker(application);
    await push(application, driver, 'test.rude-slow', {});
    const stop = new AbortController();
    const running = w.run({ queues: ['default'], signal: stop.signal, stopTimeout: 0.05 });
    await sleep(20);
    stop.abort();
    expect(await running).toMatchObject({ reason: 'interrupted' });
    expect(driver.entries()).toMatchObject([{ reserved: false, attempts: 1 }]);
  });

  it('refuses to start when retryAfter does not cover a job timeout plus the stop timeout', () => {
    const registry = new JobRegistry().add([WelcomeJob, PoliteSlowJob], 'module test');
    expect(() => checkTimeouts(registry, 'database', 70, 10)).toThrow(QueueSetupError);
    expect(() => checkTimeouts(registry, 'database', 70, 10)).toThrow(
      'The queue connection "database" gives a claimed job 70s (retryAfter) before another worker may take it, but test.welcome (timeout 60s) may hold it for its timeout plus the worker\'s --stop-timeout of 10s — a second worker would run it while the first still does. Raise retryAfter (e.g. DB_QUEUE_RETRY_AFTER) above timeout + stop timeout, or lower the job\'s static timeout.',
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

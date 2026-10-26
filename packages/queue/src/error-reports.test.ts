import { Clock, createApplication, ErrorReports, Logger, type Application, type ErrorReport, type ErrorReporter } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from './__fixtures__/targets.ts';
import { QueueConnections } from './connections.ts';
import { QueueFake } from './fake.ts';
import { JobPayloadError } from './runner.ts';
import { Queue, QueueServiceProvider, type JobContext, type JobPayload } from './index.ts';

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';
const SECRET = 'payload-secret-77';

const reports: ErrorReport[] = [];
/** Every line the app logs, with its fields. */
const logged: string[] = [];
const capture: Logger = {
  debug() {},
  info() {},
  warn: (message, context) => void logged.push(`${message} ${JSON.stringify(context ?? {})}`),
  error: (message, context) => void logged.push(`${message} ${JSON.stringify(context ?? {})}`),
  child: () => capture,
};
/** Set: every report queues an alert job, as a reporter that pages someone through the queue would. */
let alerting = false;

/** Fails on every attempt; its payload carries a value that must never reach a reporter. */
class BrokenJob {
  static readonly job = 'test.broken';
  static readonly schema = v.object({ secret: v.string() });
  static readonly tries = 2;
  static readonly backoff = [0];
  handle(): never {
    throw new Error('the mail server said no');
  }
}

class GivesUpJob {
  static readonly job = 'test.gives-up';
  static readonly schema = v.object({});
  static readonly tries = 3;
  handle(_payload: JobPayload<typeof GivesUpJob>, job: JobContext): void {
    job.fail('the account is gone');
  }
}

/** Set: the alert queues a second job that fails, as an alert that queues a follow-up would. */
let followUp = false;

/** The alert: fails, so a loop would show. */
class AlertJob {
  static readonly job = 'test.alert';
  static readonly schema = v.object({ about: v.string() });
  static readonly inject = [Queue];
  readonly #queue: Queue;
  constructor(queue: Queue) {
    this.#queue = queue;
  }
  async handle(): Promise<never> {
    if (followUp) await this.#queue.dispatch(FollowUpJob, {});
    throw new Error('the pager is down');
  }
}

class PrefsJob {
  static readonly job = 'test.prefs';
  static readonly schema = v.object({ prefs: v.lazy(() => (schemaMode === 'dispatch' ? v.record(v.string(), v.string()) : v.record(v.string(), v.number()))) });
  handle(): void {}
}

class FollowUpJob {
  static readonly job = 'test.follow-up';
  static readonly schema = v.object({});
  handle(): never {
    throw new Error('the follow-up failed');
  }
}

/** An encrypted job whose schema changes between dispatch and run: its secret field then has the wrong type, and the schema's message quotes it. */
let schemaMode: 'dispatch' | 'run' = 'dispatch';
class SecretJob {
  static readonly job = 'test.secret';
  static readonly schema = v.object({ token: v.lazy(() => (schemaMode === 'dispatch' ? v.string() : v.number())) });
  static readonly encrypted = true;
  handle(): void {}
}

/** An encrypted job that finds its payload wrong while it runs and says so with the schema's own issues. */
class MismatchJob {
  static readonly job = 'test.mismatch';
  static readonly schema = v.object({ token: v.string() });
  static readonly encrypted = true;
  async handle(payload: unknown, job: JobContext): Promise<void> {
    const result = await v.object({ token: v.number() })['~standard'].validate(payload);
    if (result.issues) return job.fail(new JobPayloadError('The payload does not match.', result.issues));
  }
}

let encryptedMode = true;
/** A job whose class loses `static encrypted` (a release drops it) while encrypted records of it wait. */
class DroppedJob {
  static readonly job = 'test.dropped';
  static readonly schema = v.object({ token: v.lazy(() => (schemaMode === 'dispatch' ? v.string() : v.number())) });
  static get encrypted(): boolean {
    return encryptedMode;
  }
  handle(): void {}
}

class Collecting implements ErrorReporter {
  static readonly inject = [Queue];
  readonly #queue: Queue;
  constructor(queue: Queue) {
    this.#queue = queue;
  }
  async report(report: ErrorReport): Promise<void> {
    reports.push(report);
    if (alerting) await this.#queue.dispatch(AlertJob, { about: report.error.message });
  }
}
class ReportingProvider {
  static errorReporters = [Collecting];
}

async function boot(env: Record<string, string> = {}): Promise<Application & { clock: TestClock }> {
  const clock = new TestClock();
  const application = await createApplication(
    { root: '/tmp', discover: false, providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider, ReportingProvider], modules: [{ name: 'test', jobs: [BrokenJob, GivesUpJob, AlertJob, FollowUpJob, SecretJob, MismatchJob, DroppedJob, PrefsJob] }] },
    { env: { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY, NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env }, override: (container) => void (container.instance(Clock, clock), container.instance(Logger, capture)) },
  );
  await migrate(application.container.make(Connections));
  return Object.assign(application, { clock });
}

async function work(application: Application): Promise<void> {
  const connections = application.container.make(QueueConnections);
  // The backoff is 0: the second attempt is due at once, so one run takes both. maxJobs ends a run that would never run dry.
  await connections.worker('database', 10).run({ queues: ['default'], stopWhenEmpty: true, maxJobs: 4 });
  await application.container.make(ErrorReports).flush();
}

afterEach(() => {
  reports.length = 0;
  logged.length = 0;
  alerting = false;
  followUp = false;
  schemaMode = 'dispatch';
  encryptedMode = true;
});

describe('failed jobs and the error reporters', () => {
  it('reports a job once, after its last attempt, without its payload', async () => {
    await using application = await boot();
    const id = await application.container.make(Queue).dispatch(BrokenJob, { secret: SECRET });
    await work(application);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      source: 'job',
      error: { message: 'the mail server said no' },
      context: { job: 'test.broken', jobId: id, queue: 'default', connection: 'database', attempt: '2' },
    });
    expect(JSON.stringify(reports[0])).not.toContain(SECRET);
  });

  it('reports a job that fails itself at once', async () => {
    await using application = await boot();
    await application.container.make(Queue).dispatch(GivesUpJob, {});
    await work(application);
    expect(reports).toMatchObject([{ source: 'job', error: { message: 'the account is gone' }, context: { job: 'test.gives-up', attempt: '1' } }]);
  });

  it('reports a failure of the QueueFake worker too', async () => {
    await using application = await boot();
    const fake = new QueueFake(application.container);
    await fake.dispatch(BrokenJob, { secret: SECRET });
    await fake.work();
    await application.container.make(ErrorReports).flush();
    expect(reports).toMatchObject([{ source: 'job', context: { job: 'test.broken' } }]);
  });

  it('leaves the failure of a sync job to whoever dispatched it', async () => {
    await using application = await boot({ QUEUE_DRIVER: 'sync' });
    await expect(application.container.make(Queue).dispatch(BrokenJob, { secret: SECRET })).rejects.toThrow('the mail server said no');
    await application.container.make(ErrorReports).flush();
    expect(reports).toEqual([]);
  });

  it('does not loop when a reporter queues a job that fails: the alert is logged, not reported', async () => {
    alerting = true;
    await using application = await boot();
    await application.container.make(Queue).dispatch(GivesUpJob, {});
    for (let round = 0; round < 5; round++) await work(application);
    // The job that failed is reported; the alert it started fails and is not.
    expect(reports.map((report) => report.context.job)).toEqual(['test.gives-up']);
    const failed = await application.container.make(QueueConnections).failed().all();
    expect(failed.map((job) => job.job).sort()).toEqual(['test.alert', 'test.gives-up']);
  });

  it('marks the record a reporter queued, so a worker of any process knows it', async () => {
    alerting = true;
    await using application = await boot();
    await application.container.make(Queue).dispatch(GivesUpJob, {});
    await work(application);
    const failed = await application.container.make(QueueConnections).failed().all();
    expect(failed.map((job) => [job.job, JSON.parse(job.payload).fromReporter])).toEqual(expect.arrayContaining([['test.alert', true], ['test.gives-up', undefined]]));
  });

  it('keeps a record key of a payload out of the field names: the key is data', async () => {
    await using application = await boot();
    await application.container.make(Queue).dispatch(PrefsJob, { prefs: { 'ada@example.com': 'on' } });
    schemaMode = 'run';
    await work(application);
    application.clock.travel({ hours: 7 });
    await work(application);
    expect(reports).toMatchObject([{ error: { message: 'The data of test.prefs does not match its schema (fields: prefs.*).' } }]);
    expect(JSON.stringify(reports)).not.toContain('ada@example.com');
  });

  it('marks the job an alert queues too, so a follow-up that fails is not reported either', async () => {
    alerting = true;
    followUp = true;
    await using application = await boot();
    await application.container.make(Queue).dispatch(GivesUpJob, {});
    for (let round = 0; round < 3; round++) await work(application);
    expect(reports.map((report) => report.context.job)).toEqual(['test.gives-up']);
    const failed = await application.container.make(QueueConnections).failed().all();
    expect(failed.map((job) => [job.job, JSON.parse(job.payload).fromReporter])).toEqual(expect.arrayContaining([['test.follow-up', true]]));
  });

  it('reports a payload that no longer matches its schema by field names, not the values the schema quotes', async () => {
    await using application = await boot();
    await application.container.make(Queue).dispatch(SecretJob, { token: SECRET });
    schemaMode = 'run';
    await work(application);
    // Held for a worker that may accept it: nothing is reported yet.
    expect(reports).toEqual([]);
    application.clock.travel({ hours: 7 });
    await work(application);
    expect(reports).toMatchObject([{ source: 'job', error: { message: 'The data of test.secret does not match its schema (fields: token).' }, context: { job: 'test.secret' } }]);
    expect(JSON.stringify(reports)).not.toContain(SECRET);
    // The failed job names the fields, not the values the schema's text quotes — nor does any line logged while it was held.
    const [failed] = await application.container.make(QueueConnections).failed().all();
    expect(failed!.exception).toContain('fields: token');
    expect(failed!.exception).not.toContain(SECRET);
    expect(failed!.exception).not.toContain('received');
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('names fields only for a stored encrypted record whose class no longer says encrypted', async () => {
    await using application = await boot();
    await application.container.make(Queue).dispatch(DroppedJob, { token: SECRET });
    encryptedMode = false;
    schemaMode = 'run';
    await work(application);
    application.clock.travel({ hours: 7 });
    await work(application);
    const [failed] = await application.container.make(QueueConnections).failed().all();
    expect(failed!.exception).toContain('fields: token');
    expect(failed!.exception).not.toContain(SECRET);
    expect(JSON.stringify(reports)).not.toContain(SECRET);
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('names fields only when an encrypted payload is refused at dispatch — the error reaches retries and failed jobs of the dispatching job', async () => {
    await using application = await boot();
    schemaMode = 'run';
    const error = await application.container.make(Queue).dispatch(SecretJob, { token: SECRET } as never).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(JobPayloadError);
    expect((error as Error).message).toContain('fields: token');
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('keeps the schema issues, which carry the value, out of the failed job of an encrypted payload', async () => {
    await using application = await boot();
    await application.container.make(Queue).dispatch(SecretJob, { token: SECRET });
    schemaMode = 'run';
    await application.container.make(Queue).dispatch(MismatchJob, { token: SECRET });
    await work(application);
    const failed = await application.container.make(QueueConnections).failed().all();
    expect(failed.map((entry) => entry.job)).toContain('test.mismatch');
    for (const entry of failed) expect(entry.exception).not.toContain(SECRET);
    expect(JSON.stringify(reports)).not.toContain(SECRET);
    expect(logged.join('\n')).not.toContain(SECRET);
  });
});

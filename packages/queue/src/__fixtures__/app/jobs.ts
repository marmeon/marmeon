import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CommandInput } from 'marmeon';
import { Database, sql } from '@marmeon/database';
import * as v from 'valibot';
import { Queue, withoutOverlapping, type JobContext, type JobPayload } from '../../index.ts';

// Jobs of the worker fixture app (`worker-processes.test.ts`): each records what it did in the table `handled`, so the
// test (another process) can count executions. Built through the container — `Database` is injected.

/** Records itself, once per execution. */
export class RecordJob {
  static readonly job = 'fixture.record';
  static readonly schema = v.object({ n: v.number() });
  static readonly tries = 3;
  static readonly timeout = 1;

  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async handle(payload: JobPayload<typeof RecordJob>, job: JobContext): Promise<void> {
    await sql`insert into handled (uuid, n, attempt, pid, event) values (${job.id}, ${payload.n}, ${job.attempt}, ${process.pid}, 'done')`.execute(this.#db);
  }
}

/** Takes `ms` (ignoring its signal), then records itself. */
export class SlowJob {
  static readonly job = 'fixture.slow';
  static readonly schema = v.object({ n: v.number(), ms: v.number() });
  static readonly timeout = 1;

  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async handle(payload: JobPayload<typeof SlowJob>, job: JobContext): Promise<void> {
    await sql`insert into handled (uuid, n, attempt, pid, event) values (${job.id}, ${payload.n}, ${job.attempt}, ${process.pid}, 'started')`.execute(this.#db);
    await sleep(payload.ms);
    await sql`insert into handled (uuid, n, attempt, pid, event) values (${job.id}, ${payload.n}, ${job.attempt}, ${process.pid}, 'done')`.execute(this.#db);
  }
}

/**
 * Holds its worker until the test says go (a row with the event `go` in `handled`), at most 0.6 s — well within its
 * timeout, and never past its signal. Two of them prove that two workers take jobs at the same time before a race starts.
 */
export class GateJob {
  static readonly job = 'fixture.gate';
  static readonly schema = v.object({ n: v.number() });
  static readonly timeout = 1;

  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async handle(payload: JobPayload<typeof GateJob>, job: JobContext): Promise<void> {
    await sql`insert into handled (uuid, n, attempt, pid, event) values (${job.id}, ${payload.n}, ${job.attempt}, ${process.pid}, 'started')`.execute(this.#db);
    const deadline = Date.now() + 600;
    const open = async () => (await sql`select 1 from handled where event = 'go'`.execute(this.#db)).rows.length > 0;
    while (Date.now() < deadline && !job.signal.aborted && !(await open())) await sleep(10);
    await sql`insert into handled (uuid, n, attempt, pid, event) values (${job.id}, ${payload.n}, ${job.attempt}, ${process.pid}, 'done')`.execute(this.#db);
  }
}

/** On its first attempt it never finishes and ignores `job.signal` (a hung SMTP call); later attempts finish at once. */
export class StubbornJob {
  static readonly job = 'fixture.stubborn';
  static readonly schema = v.object({ n: v.number() });
  static readonly tries = 3;
  static readonly timeout = 1;

  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async handle(payload: JobPayload<typeof StubbornJob>, job: JobContext): Promise<void> {
    if (job.attempt === 1) {
      await sql`insert into handled (uuid, n, attempt, pid, event) values (${job.id}, ${payload.n}, ${job.attempt}, ${process.pid}, 'started')`.execute(this.#db);
      // Never settles, whatever the signal says — and, like a hung socket, keeps the process busy.
      await new Promise(() => setInterval(() => {}, 1000));
    }
    await sql`insert into handled (uuid, n, attempt, pid, event) values (${job.id}, ${payload.n}, ${job.attempt}, ${process.pid}, 'done')`.execute(this.#db);
  }
}

/** A user id job, for the poison test: the schema says number. */
export class UserJob {
  static readonly job = 'fixture.user';
  static readonly schema = v.object({ userId: v.number() });
  static readonly tries = 5;
  static readonly timeout = 1;

  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async handle(payload: JobPayload<typeof UserJob>, job: JobContext): Promise<void> {
    await sql`insert into handled (uuid, n, attempt, pid, event) values (${job.id}, ${payload.userId}, ${job.attempt}, ${process.pid}, 'done')`.execute(this.#db);
  }
}

/** Takes `ms`, recording when it started and ended — two runs with one key must never overlap (`withoutOverlapping`). */
export class GuardedJob {
  static readonly job = 'fixture.guarded';
  static readonly schema = v.object({ n: v.number(), key: v.string(), ms: v.number() });
  static readonly tries = 50;
  static readonly timeout = 1;
  static readonly middleware = [withoutOverlapping<typeof GuardedJob>((payload) => payload.key, { releaseAfter: 0.05 })];

  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async handle(payload: JobPayload<typeof GuardedJob>, job: JobContext): Promise<void> {
    await sql`insert into handled (uuid, n, attempt, pid, event, at) values (${job.id}, ${payload.n}, ${job.attempt}, ${process.pid}, 'start', ${Date.now()})`.execute(this.#db);
    await sleep(payload.ms);
    await sql`insert into handled (uuid, n, attempt, pid, event, at) values (${job.id}, ${payload.n}, ${job.attempt}, ${process.pid}, 'end', ${Date.now()})`.execute(this.#db);
  }
}

/** The same work without the middleware — the control: its runs do overlap. */
export class UnguardedJob {
  static readonly job = 'fixture.unguarded';
  static readonly schema = GuardedJob.schema;
  static readonly timeout = 1;

  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  handle(payload: JobPayload<typeof UnguardedJob>, job: JobContext): Promise<void> {
    return new GuardedJob(this.#db).handle(payload, job);
  }
}

/**
 * Sends its "mail" (a `mail` row) through `job.once` — and on its first attempt then hangs, like a worker that dies
 * after the mail went out and before the acknowledgement (the test kills it). `once: false` sends without the marker.
 */
export class MailOnceJob {
  static readonly job = 'fixture.mail-once';
  static readonly schema = v.object({ n: v.number(), once: v.boolean() });
  static readonly tries = 3;
  static readonly timeout = 1;

  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async handle(payload: JobPayload<typeof MailOnceJob>, job: JobContext): Promise<void> {
    const send = () => sql`insert into handled (uuid, n, attempt, pid, event) values (${job.id}, ${payload.n}, ${job.attempt}, ${process.pid}, 'mail')`.execute(this.#db);
    if (payload.once) await job.once(`fixture-mail:${payload.n}`, send);
    else await send();
    if (job.attempt === 1) {
      await sql`insert into handled (uuid, n, attempt, pid, event) values (${job.id}, ${payload.n}, ${job.attempt}, ${process.pid}, 'hang')`.execute(this.#db);
      await new Promise(() => setInterval(() => {}, 1000));
    }
  }
}

export const fixtureJobs = [RecordJob, SlowJob, GateJob, StubbornJob, UserJob, GuardedJob, UnguardedJob, MailOnceJob];

/**
 * `marmeon fixture:dispatch --count=20 [--unique=key] [--n=1]`: dispatches `fixture.record` jobs at once — after printing
 * "ready" and reading "go" on stdin, so two processes start together — and prints how many were queued.
 */
export class DispatchCommand {
  static command = 'fixture:dispatch';
  static description = 'Dispatch fixture jobs (worker-processes.test.ts)';
  static options = { count: { type: 'string' }, unique: { type: 'string' }, n: { type: 'string' } } as const;

  readonly #queue: Queue;

  constructor(queue: Queue) {
    this.#queue = queue;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const count = Number(options.count ?? 1);
    const n = Number(options.n ?? process.pid);
    // Warm up (connections, script loading) on another queue, so the race starts with everything open.
    await this.#queue.size('warm-up');
    output.line('ready');
    for await (const line of createInterface({ input: process.stdin })) if (line === 'go') break;
    const unique = typeof options.unique === 'string' ? options.unique : undefined;
    const ids = await Promise.all(
      Array.from({ length: count }, () => (unique ? this.#queue.dispatch(RecordJob, { n }, { unique }) : this.#queue.dispatch(RecordJob, { n }))),
    );
    output.line(`queued ${ids.filter((id) => id !== undefined).length}`);
    return 0;
  }
}

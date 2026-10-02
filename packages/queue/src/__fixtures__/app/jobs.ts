import { setTimeout as sleep } from 'node:timers/promises';
import { Database, sql } from '@bespokecore/database';
import * as v from 'valibot';
import type { JobContext, JobPayload } from '../../index.ts';

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

export const fixtureJobs = [RecordJob, SlowJob, StubbornJob, UserJob];

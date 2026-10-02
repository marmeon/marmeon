import { AssertionError } from 'node:assert';
import { isDeepStrictEqual } from 'node:util';
import { afterCommit, Clock, inTransaction, Logger, type Container } from '@bespokecore/core';
import type { Kysely } from '@bespokecore/database';
import { QueueConnections } from './connections.ts';
import type { FailedJob } from './driver.ts';
import { MemoryFailedJobStore, MemoryQueueDriver } from './drivers/memory.ts';
import type { CheckJob, DispatchOptions, JobClass, JobInput, PendingJob } from './job.ts';
import { prepareRecord, type PendingJobs, type Queue } from './queue.ts';
import { JobRegistry } from './registry.ts';
import { delaySeconds, JobRunner } from './runner.ts';
import { Worker, type WorkOptions, type WorkResult } from './worker.ts';

/** A job the fake recorded: its class, the payload as dispatched, where it was to go. */
export interface DispatchedJob<J extends JobClass = JobClass> {
  readonly job: J;
  readonly payload: JobInput<J>;
  /** The job's id. */
  readonly id: string;
  readonly queue: string | undefined;
  readonly connection: string | undefined;
  /** Seconds. */
  readonly delay: number;
  /** Dispatched inside a transaction — `connections.transaction()` (recorded with its commit) or `queue.using(trx)`. */
  readonly inTransaction: boolean;
}

/** Which dispatches an assertion means: a part of the payload (`{ userId: 7 }`), or a test of the whole dispatch. */
export type DispatchMatch<J extends JobClass> = Partial<JobInput<J>> | ((payload: JobInput<J>, dispatched: DispatchedJob<J>) => boolean);

const FAKE_CONNECTION = 'fake';

/**
 * Records jobs instead of queuing them — `@bespokecore/testing` puts it in place of the `Queue` (`app.queue`, E101), like
 * `MailFake`. Payloads are still checked against the job's schema (a bad dispatch fails the test), and the jobs wait in
 * memory: `app.queue.work()` runs them for real in the test — through the container (injection, a scope per attempt),
 * with retries, backoff (move the time with `app.travel`) and failed jobs.
 */
export class QueueFake implements Queue {
  readonly #container: Container;
  readonly #dispatched: DispatchedJob[] = [];
  #driver: MemoryQueueDriver | undefined;
  readonly #failed = new MemoryFailedJobStore();
  readonly #inTransaction: boolean;
  readonly #root: QueueFake | undefined;

  constructor(container: Container, root?: QueueFake) {
    this.#container = container;
    this.#root = root;
    this.#inTransaction = root !== undefined;
  }

  // --- Queue ---------------------------------------------------------------

  async dispatch<J extends JobClass>(job: J & CheckJob<J>, payload: JobInput<J>, options: DispatchOptions = {}): Promise<string> {
    const [id] = await this.#record([[job, payload]], options);
    return id!;
  }

  bulk<const J extends readonly JobClass[]>(jobs: PendingJobs<J>, options: DispatchOptions = {}): Promise<string[]> {
    return this.#record(jobs as unknown as readonly PendingJob[], options);
  }

  using(_transaction: Kysely<any>): Queue {
    return new QueueFake(this.#container, this.#owner);
  }

  async size(queue = 'default'): Promise<number> {
    return this.#owner.#memory().size(queue);
  }

  // --- Inspection and assertions -------------------------------------------

  /** The dispatches of a job class (optionally only the matching ones), oldest first. */
  dispatched<J extends JobClass>(job: J, match?: DispatchMatch<J>): DispatchedJob<J>[] {
    return this.#owner.#dispatched.filter((entry): entry is DispatchedJob<J> => entry.job === job && matches(entry as DispatchedJob<J>, match));
  }

  assertDispatched<J extends JobClass>(job: J, match?: DispatchMatch<J>): this {
    if (this.dispatched(job, match).length === 0) {
      throw new AssertionError({ message: `Expected ${job.name} (${job.job}) to be dispatched${match ? ' matching the given payload' : ''}. Dispatched: ${this.#summary()}.` });
    }
    return this;
  }

  assertDispatchedTimes<J extends JobClass>(job: J, times: number, match?: DispatchMatch<J>): this {
    const actual = this.dispatched(job, match).length;
    if (actual !== times) throw new AssertionError({ message: `Expected ${times} × ${job.name} (${job.job}), dispatched ${actual}.`, actual, expected: times });
    return this;
  }

  assertNotDispatched<J extends JobClass>(job: J, match?: DispatchMatch<J>): this {
    const found = this.dispatched(job, match);
    if (found.length > 0) {
      throw new AssertionError({ message: `Expected no ${job.name} (${job.job})${match ? ' matching the given payload' : ''} to be dispatched, found ${found.length}: ${found.map((entry) => JSON.stringify(entry.payload)).join(', ')}.` });
    }
    return this;
  }

  assertNothingDispatched(): this {
    if (this.#owner.#dispatched.length > 0) throw new AssertionError({ message: `Expected no job to be dispatched. Dispatched: ${this.#summary()}.` });
    return this;
  }

  // --- Running the jobs for real -------------------------------------------

  /**
   * Runs the queued jobs that are due, for real, in this process — until none is left that is due now (a released job
   * with a backoff waits: `app.travel({ seconds: 10 })`, then `work()` again). Jobs dispatched by jobs run too.
   */
  async work(options: Partial<Pick<WorkOptions, 'queues' | 'maxJobs' | 'stopTimeout'>> = {}): Promise<WorkResult> {
    const owner = this.#owner;
    const driver = owner.#memory();
    const queues = options.queues ?? [...new Set(driver.entries().map((entry) => entry.queue))];
    const container = owner.#container;
    const registry = container.make(JobRegistry);
    const connections = container.make(QueueConnections);
    const worker = new Worker({
      driver,
      connection: FAKE_CONNECTION,
      runner: new JobRunner(container, registry, () => connections.cipher()),
      failed: owner.#failed,
      clock: container.make(Clock),
      logger: container.make(Logger).child({ channel: 'queue' }),
    });
    return worker.run({ queues: queues.length > 0 ? queues : ['default'], stopWhenEmpty: true, stopTimeout: options.stopTimeout ?? 1, ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }) });
  }

  /** Jobs `work()` recorded as failed, newest first. */
  failed(): Promise<FailedJob[]> {
    return this.#owner.#failed.all();
  }

  /** Jobs still waiting (or released for later). */
  pending(): readonly { readonly queue: string; readonly payload: string; readonly attempts: number; readonly availableAt: number }[] {
    return this.#owner.#memory().entries();
  }

  get #owner(): QueueFake {
    return this.#root ?? this;
  }

  #memory(): MemoryQueueDriver {
    this.#driver ??= new MemoryQueueDriver({ clock: this.#container.make(Clock), retryAfter: 3600 });
    return this.#driver;
  }

  async #record(jobs: readonly PendingJob[], options: DispatchOptions): Promise<string[]> {
    const owner = this.#owner;
    const container = owner.#container;
    const connections = container.make(QueueConnections);
    const deps = { registry: container.make(JobRegistry), cipher: () => connections.cipher(), clock: container.make(Clock) };
    const delay = delaySeconds(options.delay);
    // Checked like a real dispatch — registered, JSON, the schema — before any is recorded.
    const records = await Promise.all(jobs.map(([job, payload]) => prepareRecord(deps, job, payload)));
    const ambient = !this.#inTransaction && inTransaction();
    const record = async () => {
      for (const [index, { record, serialized }] of records.entries()) {
        const [job, payload] = jobs[index]!;
        owner.#dispatched.push({ job, payload, id: record.uuid, queue: options.queue, connection: options.connection, delay, inTransaction: this.#inTransaction || ambient });
        await owner.#memory().push(options.queue ?? 'default', serialized, delay);
      }
    };
    // Like the database queue (E85, E107): a job dispatched inside a transaction exists once it commits, never after a rollback.
    if (ambient) await afterCommit(record);
    else await record();
    return records.map(({ record }) => record.uuid);
  }

  #summary(): string {
    const list = this.#owner.#dispatched;
    return list.length === 0 ? 'nothing' : list.map((entry) => `${entry.job.name} ${JSON.stringify(entry.payload)}`).join('; ');
  }
}

function matches<J extends JobClass>(entry: DispatchedJob<J>, match: DispatchMatch<J> | undefined): boolean {
  if (match === undefined) return true;
  if (typeof match === 'function') return match(entry.payload, entry);
  const payload = entry.payload as Record<string, unknown>;
  return Object.entries(match as Record<string, unknown>).every(([key, value]) => isDeepStrictEqual(payload?.[key], value));
}

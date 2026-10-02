import { AssertionError } from 'node:assert';
import { isDeepStrictEqual } from 'node:util';
import { afterCommit, afterRollback, Clock, inTransaction, Logger, type Container } from '@bespokecore/core';
import type { Kysely } from '@bespokecore/database';
import { QueueConnections } from './connections.ts';
import type { FailedJob, JobRecord, UniqueRecord } from './driver.ts';
import { MemoryFailedJobStore, MemoryQueueDriver } from './drivers/memory.ts';
import type { BatchOptions, CheckJob, DispatchOptions, DispatchResult, JobClass, JobInput, PendingJob, UniqueDispatchOptions } from './job.ts';
import { uniqueLock, uniqueRecord } from './locks.ts';
import { prepareChain, prepareRecord, type PendingJobs, type Queue } from './queue.ts';
import { QueueError, JobRegistry } from './registry.ts';
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
  /** The unique key it was dispatched with (`{ unique: 'stats:7' }`), with how long and until when its lock holds. */
  readonly unique: (Pick<UniqueRecord, 'key' | 'for' | 'until'>) | undefined;
  /** The jobs chained after it (`queue.chain([...])`), in order — empty for a job dispatched alone. */
  readonly chain: readonly { readonly job: JobClass; readonly payload: unknown; readonly id: string }[];
}

/** Which dispatches an assertion means: a part of the payload (`{ userId: 7 }`), or a test of the whole dispatch. */
export type DispatchMatch<J extends JobClass> = Partial<JobInput<J>> | ((payload: JobInput<J>, dispatched: DispatchedJob<J>) => boolean);

/** One job of an expected chain: its class, or its class and a part of its payload. */
export type ChainMatch = JobClass | readonly [job: JobClass, payload: Record<string, unknown>];

const FAKE_CONNECTION = 'fake';

/**
 * Records jobs instead of queuing them — `@bespokecore/testing` puts it in place of the `Queue` (`app.queue`, E101), like
 * `MailFake`. Payloads are still checked against the job's schema (a bad dispatch fails the test), and the jobs wait in
 * memory: `app.queue.work()` runs them for real in the test — through the container (injection, a scope per attempt),
 * with retries, backoff (move the time with `app.travel`), failed jobs, chains, middleware and job events.
 *
 * **Unique jobs** take their lock exactly like the real queue — in the app's cache (in tests usually the memory store,
 * following `app.travel`): a second dispatch with the key is not recorded (`dispatch()` resolves undefined) until
 * `work()` ran the first (or `uniqueFor` passed), and a rollback around the dispatch frees the key again.
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

  async dispatch<J extends JobClass, const O extends DispatchOptions | UniqueDispatchOptions = DispatchOptions>(job: J & CheckJob<J>, payload: JobInput<J>, options?: O): Promise<DispatchResult<O>> {
    const [id] = await this.#record([[job, payload]], options ?? {});
    return id as DispatchResult<O>;
  }

  bulk<const J extends readonly JobClass[]>(jobs: PendingJobs<J>, options: BatchOptions = {}): Promise<string[]> {
    if ((options as { unique?: unknown }).unique !== undefined) throw new QueueError('bulk() queues no unique jobs — dispatch them one by one.');
    return this.#record(jobs as unknown as readonly PendingJob[], options as DispatchOptions) as Promise<string[]>;
  }

  async chain<const J extends readonly JobClass[]>(jobs: PendingJobs<J>, options: BatchOptions = {}): Promise<string[]> {
    if ((options as { unique?: unknown }).unique !== undefined) throw new QueueError('chain() takes no unique key — a chain is queued as it is.');
    const list = jobs as unknown as readonly PendingJob[];
    const { first, ids } = await prepareChain(this.#deps(), list);
    await this.#store([{ job: list[0]![0], payload: list[0]![1], prepared: first, chain: list.slice(1).map(([job, payload], index) => ({ job, payload, id: ids[index + 1]! })) }], options as DispatchOptions);
    return ids;
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

  /**
   * At least one dispatch of `job` (matching the payload part, if given). `{ unique }`: dispatched with that unique key —
   * `assertDispatched(RebuildStatsJob, { userId: 7 }, { unique: 'stats:7' })`.
   */
  assertDispatched<J extends JobClass>(job: J, match?: DispatchMatch<J>, options: { readonly unique?: string } = {}): this {
    const found = this.dispatched(job, match).filter((entry) => options.unique === undefined || entry.unique?.key === options.unique);
    if (found.length === 0) {
      const what = [match ? 'matching the given payload' : '', options.unique === undefined ? '' : `with the unique key "${options.unique}"`].filter(Boolean).join(' and ');
      const keys = options.unique === undefined ? '' : ` (unique keys dispatched: ${this.dispatched(job).map((entry) => entry.unique?.key ?? 'none').join(', ') || 'none'})`;
      throw new AssertionError({ message: `Expected ${job.name} (${job.job}) to be dispatched${what ? ` ${what}` : ''}${keys}. Dispatched: ${this.#summary()}.` });
    }
    return this;
  }

  /**
   * A chain of exactly these jobs, in this order (`queue.chain([...])`) — each a class, or a class and a part of its
   * payload: `assertChained([[ImportProfileJob, { id: 1 }], RebuildStatsJob])`.
   */
  assertChained(expected: readonly ChainMatch[]): this {
    const matchesLink = (want: ChainMatch, link: { job: JobClass; payload: unknown }) => {
      const [job, payload] = typeof want === 'function' ? [want, undefined] : want;
      return link.job === job && (payload === undefined || matches({ payload: link.payload } as DispatchedJob, payload as never));
    };
    const chains = this.#owner.#dispatched.filter((entry) => entry.chain.length > 0);
    const found = chains.some((entry) => {
      const links = [{ job: entry.job, payload: entry.payload }, ...entry.chain];
      return links.length === expected.length && expected.every((want, index) => matchesLink(want, links[index]!));
    });
    if (!found) {
      const names = (list: readonly ChainMatch[]) => list.map((want) => (typeof want === 'function' ? want.name : want[0].name)).join(' → ');
      const seen = chains.map((entry) => [entry.job, ...entry.chain.map((link) => link.job)].map((job) => job.name).join(' → '));
      throw new AssertionError({ message: `Expected the chain ${names(expected)}. Chains dispatched: ${seen.length > 0 ? seen.join('; ') : 'none'}.` });
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
      runner: new JobRunner(container, registry, () => connections.cipher(), () => connections.cache()),
      failed: owner.#failed,
      clock: container.make(Clock),
      logger: container.make(Logger).child({ channel: 'queue' }),
      events: connections.events,
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

  #deps() {
    const container = this.#owner.#container;
    const connections = container.make(QueueConnections);
    return { registry: container.make(JobRegistry), cipher: () => connections.cipher(), clock: container.make(Clock) };
  }

  async #record(jobs: readonly PendingJob[], options: DispatchOptions | UniqueDispatchOptions): Promise<(string | undefined)[]> {
    const deps = this.#deps();
    const unique = options.unique === undefined ? undefined : uniqueRecord(jobs[0]![0], options as UniqueDispatchOptions);
    // Checked like a real dispatch — registered, JSON, the schema — before any is recorded.
    const prepared = await Promise.all(jobs.map(([job, payload]) => prepareRecord(deps, job, payload, unique ? { unique } : {})));
    const entries = prepared.map((record, index) => ({ job: jobs[index]![0], payload: jobs[index]![1], prepared: record, chain: [] }));
    if (!unique) return this.#store(entries, options);

    // Like the real queue: the lock now (the app's cache), freed by a rollback; a duplicate is not recorded.
    const record = prepared[0]!.record as JobRecord & { unique: UniqueRecord };
    const lock = uniqueLock(await this.#owner.#container.make(QueueConnections).cache(), record);
    if (!(await lock.get())) return [undefined];
    await afterRollback(() => lock.release());
    return this.#store(entries, options);
  }

  async #store(
    entries: readonly { job: JobClass; payload: unknown; prepared: { record: JobRecord; serialized: string }; chain: DispatchedJob['chain'] }[],
    options: DispatchOptions | UniqueDispatchOptions,
  ): Promise<string[]> {
    const owner = this.#owner;
    const delay = delaySeconds(options.delay);
    const ambient = !this.#inTransaction && inTransaction();
    const record = async () => {
      for (const { job, payload, prepared, chain } of entries) {
        const { record, serialized } = prepared;
        const unique = record.unique ? { key: record.unique.key, for: record.unique.for, until: record.unique.until } : undefined;
        owner.#dispatched.push({ job, payload, id: record.uuid, queue: options.queue, connection: options.connection, delay, inTransaction: this.#inTransaction || ambient, unique, chain });
        await owner.#memory().push(options.queue ?? 'default', serialized, delay);
      }
    };
    // Like the database queue (E85, E107): a job dispatched inside a transaction exists once it commits, never after a rollback.
    if (ambient) await afterCommit(record);
    else await record();
    return entries.map(({ prepared }) => prepared.record.uuid);
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

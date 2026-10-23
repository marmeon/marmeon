import { afterCommit, afterRollback, currentJob, currentRequest, inTransaction, Redactor, token, type Application, type Clock, type Logger } from '@marmeon/core';
import { channels, type QueueDispatchMessage } from '@marmeon/core/diagnostics';
import { messageBase, trace } from '@marmeon/core/internal';
import type { Transaction } from '@marmeon/database';
import type { JobRecord, QueueDriver, UniqueRecord } from './driver.ts';
import { JobFailed, JobProcessed, JobProcessing, JobQueued, type JobEvent, type JobEvents } from './events.ts';
import type { BatchOptions, CheckJob, DispatchOptions, DispatchResult, JobClass, JobInput, PendingJob, UniqueDispatchOptions } from './job.ts';
import { releaseUnique, uniqueLock, uniqueRecord, type CacheSource } from './locks.ts';
import { backoffOf, QueueError, triesOf, type JobRegistry } from './registry.ts';
import { cipherContext, delaySeconds, nextInChain, RECORD_VERSION, toJson, validatePayload, type JobRunner, type PayloadCipher } from './runner.ts';

/**
 * Settings of one queued record that the framework's own jobs take from elsewhere — a queued listener's `tries` and
 * `backoff` (`static queue`) instead of those of the `marmeon.listener` class. A symbol key of the dispatch options:
 * not part of the public API.
 */
export const RECORD_OPTIONS: unique symbol = Symbol.for('marmeon.queue.record-options');
export interface RecordOptions {
  readonly tries?: number;
  readonly backoff?: readonly number[];
}

const dispatches = channels.tracing('queue.dispatch');
export function recordOptionsOf(options: object): RecordOptions {
  return (options as { [RECORD_OPTIONS]?: RecordOptions })[RECORD_OPTIONS] ?? {};
}

/** A `bulk()` or `chain()` list: each entry's payload typed by its job class, checked like a single dispatch. */
export type PendingJobs<J extends readonly JobClass[]> = { readonly [K in keyof J]: readonly [job: J[K] & CheckJob<J[K]>, payload: JobInput<J[K]>] };

/**
 * Queues jobs — injected like any service: `await this.#queue.dispatch(SendWelcomeMailJob, { userId: user.id })`. The
 * payload is checked against the job's `static schema` here (a mismatch is a type error, and at runtime a
 * {@link JobPayloadError}) and again before the job runs; delivery is at-least-once. **Inside a transaction**
 * (`connections.transaction()`) a job is queued only if the transaction commits. See `docs/queues.md#inside-a-transaction`.
 */
export interface Queue {
  /**
   * Queues one job. Returns its id (stable over retries).
   *
   * With `unique`: a no-op — resolving `undefined` — while one of this job with the same key is queued (or
   * running, with `uniqueUntil: 'done'`). The key's lock lives in the app's cache, taken right here (visible to every
   * process at once); a rollback of a transaction around the dispatch frees it again.
   */
  dispatch<J extends JobClass, const O extends DispatchOptions | UniqueDispatchOptions = DispatchOptions>(job: J & CheckJob<J>, payload: JobInput<J>, options?: O): Promise<DispatchResult<O>>;
  /** Queues several jobs at once: `bulk([[SendWelcomeMailJob, { userId: 1 }], [SendWelcomeMailJob, { userId: 2 }]])`. Returns their ids. */
  bulk<const J extends readonly JobClass[]>(jobs: PendingJobs<J>, options?: BatchOptions): Promise<string[]>;
  /**
   * Queues jobs to run one after the other: the first now, each next one only once the one before succeeded —
   * a job that fails for good (or discards itself) ends the chain. Every payload is checked now; the rest of the chain
   * travels in the job's record and is queued together with the acknowledgement of the job before it (one atomic step
   * of the driver). Returns the ids of all of them.
   *
   * ```ts
   * await queue.chain([[ImportProfileJob, { id }], [RebuildStatsJob, { userId }]]);
   * ```
   */
  chain<const J extends readonly JobClass[]>(jobs: PendingJobs<J>, options?: BatchOptions): Promise<string[]>;
  /**
   * The queue, writing through a database transaction you control yourself — like `repository.using(trx)`. Inside
   * `connections.transaction()` no `using()` is needed: a dispatch joins the transaction by itself.
   *
   * ```ts
   * const trx = await db.startTransaction().execute();
   * await this.#queue.using(trx).dispatch(SendWelcomeMailJob, { userId: user.id });
   * await trx.commit().execute();
   * ```
   */
  using(transaction: Transaction<any>): Queue;
  /** Jobs waiting or running on a queue (default: the connection's default queue). */
  size(queue?: string, connection?: string): Promise<number>;
}
export const Queue = token<Queue>('Queue');

/**
 * A queue connection as configured: which driver, its default queue, and (for every driver but `sync`) how long a claim holds.
 * `custom` is a driver that a provider brings (`static queueDrivers`); its queue and `retryAfter` are those its factory returned.
 */
export type QueueConnectionOptions =
  | { readonly driver: 'sync'; readonly queue: string }
  | { readonly driver: 'database' | 'redis'; readonly queue: string; readonly connection: string; readonly retryAfter: number }
  | { readonly driver: 'custom'; readonly queue: string; readonly retryAfter: number };

export interface QueueManagerDependencies {
  /** The options of a connection, `undefined` when there is none of that name. */
  readonly connection: (name: string) => QueueConnectionOptions | undefined;
  /** The names of all connections, for the message of an unknown one. */
  readonly connectionNames: () => readonly string[];
  readonly default: string;
  readonly registry: JobRegistry;
  /** The driver of a (non-sync) connection — built once per connection. */
  readonly driver: (connection: string) => QueueDriver;
  /** Runs `sync` jobs at once. */
  readonly runner: () => JobRunner;
  readonly cipher: () => Promise<PayloadCipher>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The app's cache — for the locks of unique jobs (asked for only when one is dispatched). */
  readonly cache?: CacheSource;
  /** `JobQueued` (and, for `sync`, `JobProcessing`, `JobProcessed`, `JobFailed`) — the app's `EventDispatcher`. */
  readonly events?: JobEvents;
  /** The app its dispatches are reported for on the `queue.dispatch` channel. */
  readonly app?: Application;
  /** Masks a failing listener's text in the log — the app's, so the names its packages add (the session cookie) count; without one, the core's key list. */
  readonly redactor?: Redactor;
}

/** A job checked and ready to queue: its record and that record as stored. */
interface Prepared {
  readonly record: JobRecord;
  readonly serialized: string;
}

/** The `Queue` of a running app: one driver per connection (`QUEUE_DRIVER`, or `{ connection }` per dispatch). */
export class QueueManager implements Queue {
  readonly #deps: QueueManagerDependencies;
  readonly #transaction: Transaction<any> | undefined;
  readonly #redactor: Redactor;

  constructor(dependencies: QueueManagerDependencies, transaction?: Transaction<any>) {
    this.#deps = dependencies;
    this.#transaction = transaction;
    this.#redactor = dependencies.redactor ?? new Redactor();
  }

  dispatch<J extends JobClass, const O extends DispatchOptions | UniqueDispatchOptions = DispatchOptions>(job: J & CheckJob<J>, payload: JobInput<J>, options?: O): Promise<DispatchResult<O>> {
    const given = options ?? {};
    if (!this.#deps.app || !dispatches.hasSubscribers) return this.#dispatch(job, payload, given) as Promise<DispatchResult<O>>;
    const message = this.#message('dispatch', [[job, payload]], given);
    return trace(dispatches, message, () => this.#dispatch(job, payload, given, message.traceparent), (ended, id) => {
      ended.jobIds = id === undefined ? [] : [id];
    }) as Promise<DispatchResult<O>>;
  }

  async #dispatch(job: JobClass, payload: unknown, options: DispatchOptions | UniqueDispatchOptions, traceparent?: string): Promise<string | undefined> {
    const unique = options.unique === undefined ? undefined : uniqueRecord(job, options as UniqueDispatchOptions);
    const prepared = await prepareRecord(this.#deps, job, payload, { ...recordOptionsOf(options), ...(unique ? { unique } : {}), ...(traceparent ? { traceparent } : {}) });
    if (!unique) return (await this.#push([prepared], options))[0]!;
    return this.#pushUnique(prepared as Prepared & { record: { unique: UniqueRecord } }, options);
  }

  bulk<const J extends readonly JobClass[]>(jobs: PendingJobs<J>, options: BatchOptions = {}): Promise<string[]> {
    if ((options as { unique?: unknown }).unique !== undefined) throw new QueueError('bulk() queues no unique jobs — dispatch them one by one.');
    const pending = jobs as unknown as readonly PendingJob[];
    const run = (traceparent?: string) => this.#prepareAll(pending, traceparent).then((prepared) => this.#push(prepared, options as DispatchOptions));
    if (!this.#deps.app || !dispatches.hasSubscribers) return run();
    const message = this.#message('bulk', pending, options as DispatchOptions);
    return trace(dispatches, message, () => run(message.traceparent), (ended, ids) => {
      ended.jobIds = ids;
    });
  }

  chain<const J extends readonly JobClass[]>(jobs: PendingJobs<J>, options: BatchOptions = {}): Promise<string[]> {
    if ((options as { unique?: unknown }).unique !== undefined) return Promise.reject(new QueueError('chain() takes no unique key — a chain is queued as it is.'));
    const pending = jobs as unknown as readonly PendingJob[];
    const run = async (traceparent?: string) => {
      const { first, ids } = await prepareChain(this.#deps, pending, traceparent);
      await this.#push([first], options as DispatchOptions);
      return ids;
    };
    if (!this.#deps.app || !dispatches.hasSubscribers) return run();
    const message = this.#message('chain', pending, options as DispatchOptions);
    return trace(dispatches, message, () => run(message.traceparent), (ended, ids) => {
      ended.jobIds = ids;
    });
  }

  /** A `queue.dispatch` message — only built while something listens. */
  #message(kind: QueueDispatchMessage['kind'], pending: readonly (readonly [JobClass, unknown])[], options: DispatchOptions | UniqueDispatchOptions): QueueDispatchMessage {
    const connection = options.connection ?? this.#deps.default;
    let delay = 0;
    try {
      delay = delaySeconds(options.delay);
    } catch {
      // An invalid delay fails the dispatch itself, with its message.
    }
    return {
      ...messageBase(this.#deps.app!),
      kind,
      jobs: pending.map(([job]) => (typeof job === 'function' && typeof job.job === 'string' ? job.job : String(job))),
      payloads: pending.map(([, payload]) => payload),
      encrypted: pending.map(([job]) => (job as { encrypted?: unknown }).encrypted === true),
      connection,
      queue: options.queue ?? this.#deps.connection(connection)?.queue ?? '',
      delay,
      ...(options.unique === undefined ? {} : { unique: String(options.unique) }),
      jobIds: [],
    };
  }

  using(transaction: Transaction<any>): Queue {
    if (typeof (transaction as { selectFrom?: unknown } | null)?.selectFrom !== 'function') {
      throw new QueueError('queue.using() takes a database transaction (the trx of db.transaction().execute(async (trx) => …)).');
    }
    return new QueueManager(this.#deps, transaction);
  }

  async size(queue?: string, connection = this.#deps.default): Promise<number> {
    const options = this.#connection(connection);
    if (options.driver === 'sync') return 0;
    return this.#driver(connection).size(queue ?? options.queue);
  }

  /** The connection's driver — writing and reading through the transaction, if this queue has one. */
  #driver(name: string): QueueDriver {
    const driver = this.#deps.driver(name);
    if (this.#transaction === undefined) return driver;
    if (!driver.using) throw new QueueError(`The ${this.#connection(name).driver} queue connection "${name}" cannot write into a database transaction.`);
    return driver.using(this.#transaction);
  }

  #prepareAll(jobs: readonly PendingJob[], traceparent?: string): Promise<Prepared[]> {
    // Every payload is checked before the first is queued: a bad one queues none.
    return Promise.all(jobs.map(([job, payload]) => prepareRecord(this.#deps, job, payload, traceparent ? { traceparent } : {})));
  }

  /**
   * A unique job: its lock first — on the cache's own connection, outside any transaction, so every process sees
   * it at once — then, inside a transaction, `afterRollback` to free it again if the job never comes to exist, then the
   * push (into the transaction, or held until its commit).
   */
  async #pushUnique(prepared: Prepared & { record: { unique: UniqueRecord } }, options: DispatchOptions | UniqueDispatchOptions): Promise<string | undefined> {
    const { record } = prepared;
    const lock = uniqueLock(await this.#cache(), record);
    if (!(await lock.get())) {
      this.#deps.logger.debug(`Not queued: ${record.job} with the unique key "${record.unique.key}" is queued already`, { job: record.job, unique: record.unique.key });
      return undefined;
    }
    await afterRollback(() => lock.release());
    try {
      await this.#push([prepared], options, () => lock.release());
    } catch (error) {
      await lock.release().catch(() => {});
      throw error;
    }
    return record.uuid;
  }

  /** `failed`: frees what the dispatch took (a unique lock) when a push held until the commit fails after it. */
  async #push(prepared: readonly Prepared[], options: DispatchOptions | UniqueDispatchOptions, failed?: () => Promise<unknown>): Promise<string[]> {
    const name = options.connection ?? this.#deps.default;
    const connection = this.#connection(name);
    const queue = options.queue ?? connection.queue;
    const delay = delaySeconds(options.delay);
    const ids = prepared.map(({ record }) => record.uuid);
    const queued = () => Promise.all(prepared.map(({ record }) => this.#emit(new JobQueued({ connection: name, queue, job: record.job, jobId: record.uuid, delay }))));

    if (connection.driver === 'sync') {
      // Held until the commit inside a transaction: a sync job must never act on data that is rolled back.
      await afterCommit(async () => {
        await queued();
        await this.#runNow(prepared, queue, name);
      });
      return ids;
    }

    const driver = this.#driver(name);
    const availableAt = this.#deps.clock.now() + Math.round(delay * 1000);
    const push = async () => {
      for (const { record } of prepared) await driver.push(queue, JSON.stringify({ ...record, availableAt }), delay);
    };
    // Explicitly through a transaction (`using(trx)`), or joining the ambient one: part of it. Inside a transaction the
    // driver cannot join (another database connection, redis): after the commit.
    if (this.#transaction === undefined && inTransaction() && !(await driver.joinsTransaction?.())) {
      await afterCommit(async () => {
        try {
          await push();
        } catch (error) {
          await failed?.().catch(() => {});
          throw error;
        }
        await queued();
      });
    } else {
      await push();
      // Joined a transaction: queued once it commits.
      if (this.#transaction === undefined) await afterCommit(queued);
      else await queued();
    }
    return ids;
  }

  /** The `sync` connection: each job (and the rest of its chain) runs now, in its own scope; an error reaches the caller. */
  async #runNow(prepared: readonly Prepared[], queue: string, connection: string): Promise<void> {
    const runner = this.#deps.runner();
    for (const { serialized } of prepared) {
      let next: string | undefined = serialized;
      while (next !== undefined) {
        const ready = await runner.prepare(next);
        if (ready.kind !== 'ready') throw new QueueError(ready.reason);
        const { record } = ready;
        const about = { connection, queue, job: record.job, jobId: record.uuid };
        await this.#emit(new JobProcessing({ ...about, attempt: 1 }));
        await releaseUnique(this.#cache, record, 'processing');
        const started = performance.now();
        let requested;
        try {
          requested = await runner.run(ready, { attempt: 1, queue, connection, signal: new AbortController().signal });
          if (requested?.kind === 'fail') throw requested.reason instanceof Error ? requested.reason : new QueueError(`${record.job} failed: ${requested.reason}`);
          if (requested?.kind === 'release') {
            throw new QueueError(`${record.job} released itself, but the sync connection runs a job only once, at dispatch — queue it on a worker's connection to run it again later.`);
          }
        } catch (error) {
          await this.#emit(new JobFailed({ ...about, attempt: 1, error: error instanceof Error ? error : new Error(String(error)) }));
          throw error;
        } finally {
          await releaseUnique(this.#cache, record, 'done');
        }
        await this.#emit(new JobProcessed({ ...about, attempt: 1, ms: Math.round(performance.now() - started), discarded: requested?.kind === 'discard' }));
        next = requested?.kind === 'discard' ? undefined : nextInChain(record, this.#deps.clock.now());
      }
    }
  }

  #cache = async () => {
    if (!this.#deps.cache) throw new QueueError('Unique jobs need the app\'s cache (@marmeon/cache) — this queue was built without one.');
    return this.#deps.cache();
  };

  async #emit(event: JobEvent): Promise<void> {
    if (!this.#deps.events) return;
    try {
      await this.#deps.events(event);
    } catch (error) {
      this.#deps.logger.warn(`A listener of ${event.constructor.name} failed: ${this.#redactor.text(error instanceof Error ? error.message : String(error))}`, { job: event.job, jobId: event.jobId });
    }
  }

  #connection(name: string): QueueConnectionOptions {
    const options = this.#deps.connection(name);
    if (!options) throw new QueueError(`The queue connection "${name}" is not configured. Known: ${this.#deps.connectionNames().join(', ')}.`);
    return options;
  }
}

/** A chain checked and ready to queue: its first job's record carries the rest. */
export async function prepareChain(
  deps: Parameters<typeof prepareRecord>[0],
  jobs: readonly PendingJob[],
  traceparent?: string,
): Promise<{ first: Prepared; ids: string[] }> {
  if (jobs.length === 0) throw new QueueError('chain() needs at least one job.');
  const links = await Promise.all(jobs.map(([job, payload]) => prepareRecord(deps, job, payload, traceparent ? { traceparent } : {})));
  const [head, ...rest] = links.map(({ record }) => record);
  const record: JobRecord = rest.length > 0 ? { ...head!, chain: rest } : head!;
  return { first: { record, serialized: JSON.stringify(record) }, ids: links.map(({ record }) => record.uuid) };
}

/** Checks a job and its payload and builds what the queue stores (encrypted with `static encrypted`). */
export async function prepareRecord(
  deps: { readonly registry: JobRegistry; readonly cipher: () => Promise<PayloadCipher>; readonly clock: Clock },
  job: JobClass,
  payload: unknown,
  extra: RecordOptions & { readonly unique?: UniqueRecord; readonly traceparent?: string } = {},
): Promise<{ record: JobRecord; serialized: string }> {
  if (typeof job !== 'function' || typeof job.job !== 'string') throw new QueueError(`Only job classes can be dispatched (a class with static job and static schema), not ${String(job)}.`);
  if (!deps.registry.has(job)) {
    const other = deps.registry.get(job.job);
    throw new QueueError(
      other
        ? `${job.name} is named "${job.job}", but that name belongs to ${other.name} in this app's jobs.`
        : `${job.name} (${job.job}) is not registered — a worker could not run it. Add it to its module: defineModule({ jobs: [${job.name}] }).`,
    );
  }
  // What a worker will see: the JSON of the payload — checked now, so a Date or a class instance fails here, not there.
  const json = toJson(job, payload);
  await validatePayload(job, json, 'dispatch');
  const uuid = crypto.randomUUID();
  // Where it comes from: the request's id always — in a job, the request that job came from —, the trace context
  // when a tracer gave one at dispatch.
  const requestId = currentRequest()?.requestId ?? currentJob()?.requestId;
  const data = job.encrypted ? await (await deps.cipher()).encrypt(JSON.stringify(json), cipherContext(job.job)) : json;
  const record: JobRecord = {
    v: RECORD_VERSION,
    uuid,
    job: job.job,
    data,
    ...(job.encrypted ? { encrypted: true as const } : {}),
    tries: extra.tries ?? triesOf(job),
    backoff: extra.backoff ? [...extra.backoff] : backoffOf(job),
    dispatchedAt: deps.clock.now(),
    ...(extra.unique ? { unique: extra.unique } : {}),
    ...(requestId === undefined ? {} : { requestId }),
    ...(extra.traceparent === undefined ? {} : { traceparent: extra.traceparent }),
  };
  return { record, serialized: JSON.stringify(record) };
}

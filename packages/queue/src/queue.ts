import { token, type Clock, type Logger } from '@bespokecore/core';
import type { Kysely } from '@bespokecore/database';
import type { JobRecord, QueueDriver } from './driver.ts';
import type { CheckJob, DispatchOptions, JobClass, JobInput, PendingJob } from './job.ts';
import { backoffOf, QueueError, triesOf, type JobRegistry } from './registry.ts';
import { cipherContext, delaySeconds, toJson, validatePayload, type JobRunner, type PayloadCipher } from './runner.ts';

/** A `bulk()` list: each entry's payload typed by its job class, checked like a single dispatch. */
export type PendingJobs<J extends readonly JobClass[]> = { readonly [K in keyof J]: readonly [job: J[K] & CheckJob<J[K]>, payload: JobInput<J[K]>] };

/**
 * Queues jobs (E83, E84) — injected like any service, no facade:
 *
 * ```ts
 * constructor(queue: Queue) { this.#queue = queue; }
 * await this.#queue.dispatch(SendWelcomeMailJob, { userId: user.id }, { delay: 60, queue: 'mail' });
 * ```
 *
 * The payload is checked against the job's `static schema` here (a mismatch is a type error, and at runtime a
 * {@link JobPayloadError}) and again before the job runs. Delivery is at-least-once (E85).
 */
export interface Queue {
  /** Queues one job. Returns its id (stable over retries). */
  dispatch<J extends JobClass>(job: J & CheckJob<J>, payload: JobInput<J>, options?: DispatchOptions): Promise<string>;
  /** Queues several jobs at once: `bulk([[SendWelcomeMailJob, { userId: 1 }], [SendWelcomeMailJob, { userId: 2 }]])`. Returns their ids. */
  bulk<const J extends readonly JobClass[]>(jobs: PendingJobs<J>, options?: DispatchOptions): Promise<string[]>;
  /**
   * The queue, writing through a database transaction (E85): jobs dispatched through it are part of the transaction —
   * visible to workers with the commit, gone with a rollback. Like `repository.using(trx)`:
   *
   * ```ts
   * await db.transaction().execute(async (trx) => {
   *   const user = await this.#users.using(trx).insert({ … });
   *   await this.#queue.using(trx).dispatch(SendWelcomeMailJob, { userId: user.id });
   * });
   * ```
   */
  using(transaction: Kysely<any>): Queue;
  /** Jobs waiting or running on a queue (default: the connection's default queue). */
  size(queue?: string, connection?: string): Promise<number>;
}
export const Queue = token<Queue>('Queue');

/** A queue connection as configured: which driver, its default queue, and (for `database`) how long a claim holds. */
export type QueueConnectionOptions =
  | { readonly driver: 'sync'; readonly queue: string }
  | { readonly driver: 'database'; readonly queue: string; readonly connection: string; readonly retryAfter: number };

export interface QueueManagerDependencies {
  readonly connections: Readonly<Record<string, QueueConnectionOptions>>;
  readonly default: string;
  readonly registry: JobRegistry;
  /** The driver of a (non-sync) connection — built once per connection. */
  readonly driver: (connection: string) => QueueDriver;
  /** Runs `sync` jobs at once. */
  readonly runner: () => JobRunner;
  readonly cipher: () => Promise<PayloadCipher>;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** The `Queue` of a running app: one driver per connection (`QUEUE_CONNECTION`, or `{ connection }` per dispatch). */
export class QueueManager implements Queue {
  readonly #deps: QueueManagerDependencies;
  readonly #transaction: Kysely<any> | undefined;

  constructor(dependencies: QueueManagerDependencies, transaction?: Kysely<any>) {
    this.#deps = dependencies;
    this.#transaction = transaction;
  }

  dispatch<J extends JobClass>(job: J & CheckJob<J>, payload: JobInput<J>, options: DispatchOptions = {}): Promise<string> {
    return this.#push([[job, payload]], options).then(([id]) => id!);
  }

  bulk<const J extends readonly JobClass[]>(jobs: PendingJobs<J>, options: DispatchOptions = {}): Promise<string[]> {
    return this.#push(jobs as unknown as readonly PendingJob[], options);
  }

  using(transaction: Kysely<any>): Queue {
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

  async #push(jobs: readonly PendingJob[], options: DispatchOptions): Promise<string[]> {
    const name = options.connection ?? this.#deps.default;
    const connection = this.#connection(name);
    const queue = options.queue ?? connection.queue;
    const delay = delaySeconds(options.delay);
    // Every payload is checked before the first is queued: a bad one queues none.
    const records = await Promise.all(jobs.map(([job, payload]) => prepareRecord(this.#deps, job, payload)));

    if (connection.driver === 'sync') return this.#runNow(records, queue, name);

    const driver = this.#driver(name);
    const ids: string[] = [];
    for (const { record, serialized } of records) {
      await driver.push(queue, serialized, delay);
      ids.push(record.uuid);
    }
    return ids;
  }

  /** The `sync` connection: each job runs now, in its own scope; an error reaches the caller. */
  async #runNow(records: readonly { record: JobRecord; serialized: string }[], queue: string, connection: string): Promise<string[]> {
    const runner = this.#deps.runner();
    for (const { record, serialized } of records) {
      const prepared = await runner.prepare(serialized);
      if (prepared.kind !== 'ready') throw new QueueError(prepared.kind === 'poison' ? prepared.reason : `No job named "${record.job}" is registered.`);
      const requested = await runner.run(prepared, { attempt: 1, queue, connection, signal: new AbortController().signal });
      if (requested?.kind === 'fail') throw requested.reason instanceof Error ? requested.reason : new QueueError(`${record.job} failed: ${requested.reason}`);
      if (requested?.kind === 'release') {
        throw new QueueError(`${record.job} released itself, but the sync connection runs a job only once, at dispatch — queue it on a worker's connection to run it again later.`);
      }
    }
    return records.map(({ record }) => record.uuid);
  }

  #connection(name: string): QueueConnectionOptions {
    const options = this.#deps.connections[name];
    if (!options) throw new QueueError(`The queue connection "${name}" is not configured. Known: ${Object.keys(this.#deps.connections).join(', ')}.`);
    return options;
  }
}

/** Checks a job and its payload and builds what the queue stores (encrypted with `static encrypted`). */
export async function prepareRecord(
  deps: { readonly registry: JobRegistry; readonly cipher: () => Promise<PayloadCipher>; readonly clock: Clock },
  job: JobClass,
  payload: unknown,
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
  const data = job.encrypted ? await (await deps.cipher()).encrypt(JSON.stringify(json), cipherContext(job.job)) : json;
  const record: JobRecord = {
    uuid,
    job: job.job,
    data,
    ...(job.encrypted ? { encrypted: true as const } : {}),
    tries: triesOf(job),
    backoff: backoffOf(job),
    dispatchedAt: deps.clock.now(),
  };
  return { record, serialized: JSON.stringify(record) };
}

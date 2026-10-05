import { setTimeout as sleep } from 'node:timers/promises';
import { describeError, outsideTransaction, redactText, type Clock, type Logger } from '@bespokecore/core';
import { backoffDelay, type FailedJobStore, type JobRecord, type QueueDriver, type ReservedJob } from './driver.ts';
import { JobFailed, JobProcessed, JobProcessing, JobQueued, JobReleased, type JobEvent, type JobEvents } from './events.ts';
import { releaseUnique } from './locks.ts';
import { timeoutOf } from './registry.ts';
import { nextInChain, parseRecord, type JobRunner, type Prepared, type Requested } from './runner.ts';

/** A job did not stop within its timeout plus the grace period: Node cannot cancel it, so its worker must end. */
export class JobStuckError extends Error {
  override name = 'JobStuckError';
}

/** The job's `timeout` is over — the reason `job.signal` carries. */
export class JobTimeoutError extends Error {
  override name = 'JobTimeoutError';
}

export interface WorkOptions {
  /**
   * Queues in priority order: a job of the first is taken before any of the second. `*` stands for every other queue
   * that holds jobs (alphabetically, looked up again at least every second): `['*']`, `['mail', '*']`.
   */
  readonly queues: readonly string[];
  /** Seconds to wait when no job is available (default 1). */
  readonly sleep?: number;
  /** Stop after this many jobs (each processed attempt counts). */
  readonly maxJobs?: number;
  /** Stop after this many seconds (finishing the running job first). */
  readonly maxTime?: number;
  /** Stop as soon as no job is available. */
  readonly stopWhenEmpty?: boolean;
  /**
   * Seconds a running job may still take after a stop was asked for (SIGTERM) — then it is released and the worker
   * stops — and the grace period after a job's timeout before the worker gives up on it (default 10).
   */
  readonly stopTimeout?: number;
  /** Aborted: no new claim; the running job gets `stopTimeout` to finish. */
  readonly signal?: AbortSignal;
  /**
   * Seconds between two looks, while idle, at the queues this worker does not take (default 60; `false`: never). Jobs ready
   * on one of them at two looks in a row — and none of them running — are logged once as a warning: a worker started without
   * `--queue=mail,default` would otherwise leave the mails of the auth module waiting without a word. Not with `*`.
   */
  readonly watchOtherQueues?: number | false;
  /**
   * A job ignored its timeout and the grace period: the worker cannot go on (the job keeps running). `queue:work` logs
   * and exits the process — the supervisor restarts it, the job returns after `retryAfter`. Default: throw {@link JobStuckError}.
   */
  readonly onStuck?: (job: ReservedJob, error: JobStuckError) => void;
}

/** What one run of the worker did. */
export interface WorkResult {
  /** Attempts that ran to an outcome (processed, released, failed, discarded). */
  readonly processed: number;
  readonly failed: number;
  readonly released: number;
  /** Why it stopped. */
  readonly reason: 'empty' | 'max-jobs' | 'max-time' | 'stopped' | 'interrupted';
}

export interface WorkerDependencies {
  readonly driver: QueueDriver;
  /** The connection's name, as failed jobs and job contexts report it. */
  readonly connection: string;
  readonly runner: JobRunner;
  readonly failed: FailedJobStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Seconds a claim holds on this connection — what `withoutOverlapping` locks for by default. */
  readonly retryAfter?: number;
  /** Job events (`JobProcessing`, `JobProcessed`, `JobReleased`, `JobFailed`, `JobQueued` for the next of a chain) — the app's `EventDispatcher`. */
  readonly events?: JobEvents;
}

type Outcome = 'processed' | 'released' | 'failed' | 'interrupted';

const DEFAULT_STOP_TIMEOUT = 10;

/**
 * Takes jobs off a queue and runs them, one at a time: each attempt in its own container scope, with its log context,
 * `job.signal` aborting at the job's timeout. Errors release the job with its backoff until its tries are used up, then
 * it is recorded in the failed jobs. A job whose payload cannot run (no job record, a schema it no longer matches, an
 * unreadable ciphertext) fails at once — retrying cannot fix it. A job this app does not know (a rolling deploy: the
 * worker is older or newer than the code that queued it) is released with backoff until its tries are used up.
 *
 * Delivery is at-least-once (E85): the job leaves the queue only after `handle()` finished — a worker that dies in between
 * leaves it claimed, and it runs again once `retryAfter` is over.
 */
export class Worker {
  readonly #deps: WorkerDependencies;

  constructor(dependencies: WorkerDependencies) {
    this.#deps = dependencies;
  }

  run(options: WorkOptions): Promise<WorkResult> {
    // A boundary (E107): claims, acks and jobs never run inside a transaction of whoever started the worker.
    return outsideTransaction(() => this.#loop(options));
  }

  async #loop(options: WorkOptions): Promise<WorkResult> {
    const started = performance.now();
    const counts = { processed: 0, failed: 0, released: 0 };
    const result = (reason: WorkResult['reason']): WorkResult => ({ ...counts, reason });
    const queues = this.#queues(options.queues);
    const others = this.#others(options);
    for (;;) {
      if (options.signal?.aborted) return result('stopped');
      if (options.maxJobs !== undefined && counts.processed >= options.maxJobs) return result('max-jobs');
      if (options.maxTime !== undefined && performance.now() - started >= options.maxTime * 1000) return result('max-time');

      const job = await this.#deps.driver.reserve(await queues.current());
      if (!job) {
        queues.stale();
        if (options.stopWhenEmpty) return result('empty');
        await others.look();
        try {
          await sleep((options.sleep ?? 1) * 1000, undefined, { signal: options.signal });
        } catch {
          return result('stopped');
        }
        continue;
      }
      const outcome = await this.process(job, options);
      if (outcome === 'interrupted') return result('interrupted');
      counts.processed++;
      if (outcome === 'failed') counts.failed++;
      if (outcome === 'released') counts.released++;
    }
  }

  /** Runs one claimed job to its outcome. */
  async process(reserved: ReservedJob, options: Pick<WorkOptions, 'stopTimeout' | 'signal' | 'onStuck'> = {}): Promise<Outcome> {
    const { runner, logger } = this.#deps;
    const prepared = await runner.prepare(reserved.payload);
    const attempt = { attempt: reserved.attempts, queue: reserved.queue, connection: this.#deps.connection };
    if (prepared.kind === 'poison') {
      const error = new Error(prepared.reason);
      const fail = () => this.#fail(reserved, prepared.record, error, ' at once (it cannot run)');
      await (prepared.record ? runner.unrunnable(prepared.record, attempt, error, fail) : fail());
      return 'failed';
    }
    const { record } = prepared;
    if (prepared.kind === 'unknown') {
      const error = new Error(`No job named "${record.job}" is registered in this app (a deploy in progress, or a module's jobs: [...] is missing it).`);
      return runner.unrunnable(record, attempt, error, () => this.#retryOrFail(reserved, record, error, undefined, 'unknown'));
    }
    // A job that comes back more often than it may — its worker died during each attempt — fails instead of looping.
    if (reserved.attempts > record.tries) {
      await this.#fail(reserved, record, new Error(`${record.job} has been attempted ${reserved.attempts - 1} times without finishing (its worker stopped during each); it may run ${record.tries}.`), '');
      return 'failed';
    }

    const base = { job: record.job, jobId: record.uuid, attempt: reserved.attempts, queue: reserved.queue };
    logger.info(`Processing ${record.job}`, base);
    await this.#emit(new JobProcessing({ ...this.#about(reserved, record), attempt: reserved.attempts }));
    // A job unique until processing: a new one with its key may be queued from now on.
    await this.#releaseUnique(record, 'processing');
    const started = performance.now();
    const settled = await this.#attempt(reserved, prepared, options);
    const ms = Math.round(performance.now() - started);
    const context = { ...base, ms };

    switch (settled.kind) {
      case 'interrupted':
        // Asked to stop and the job did not finish in time: back to the queue at once, for another worker.
        await this.#deps.driver.release(reserved, 0);
        logger.warn(`Released ${record.job}: the worker is stopping and the job did not finish within the stop timeout`, context);
        await this.#emit(new JobReleased({ ...this.#about(reserved, record), attempt: reserved.attempts, delay: 0, reason: 'stopping', ms }));
        return 'interrupted';
      case 'error':
        return this.#retryOrFail(reserved, record, settled.error, ms, 'error');
      case 'done':
        break;
    }

    const requested: Requested | undefined = settled.requested;
    if (requested?.kind === 'release') {
      // Released on its last attempt (by the job, or a middleware like withoutOverlapping): no attempt is left to run it.
      if (reserved.attempts >= record.tries) {
        await this.#fail(reserved, record, new Error(`${record.job} was released on its last attempt (${reserved.attempts} of ${record.tries}) — give it more tries if it waits for something.`), '', ms);
        return 'failed';
      }
      await this.#deps.driver.release(reserved, requested.delay);
      logger.info(`Released ${record.job} (by the job), again in ${requested.delay}s`, context);
      await this.#emit(new JobReleased({ ...this.#about(reserved, record), attempt: reserved.attempts, delay: requested.delay, reason: 'job', ms }));
      return 'released';
    }
    if (requested?.kind === 'fail') {
      await this.#fail(reserved, record, typeof requested.reason === 'string' ? new Error(requested.reason) : requested.reason, ' (by the job)', ms);
      return 'failed';
    }
    // Success hands the chain on — together with the acknowledgement (one atomic step of the driver). A discarded job
    // ends its chain: what comes next was waiting for it.
    const next = requested?.kind === 'discard' ? undefined : nextInChain(record);
    const acknowledged = await this.#deps.driver.ack(reserved, next ? [{ queue: reserved.queue, payload: next, delay: 0 }] : []);
    if (!acknowledged) {
      // Another worker holds the job now: it acknowledges, frees the unique lock and hands the chain on.
      logger.warn(`${record.job} finished after its claim expired (retryAfter) — another worker may have run it as well`, context);
    } else {
      await this.#releaseUnique(record, 'done');
    }
    const dropped = requested?.kind === 'discard' && record.chain?.length ? ` (and the ${record.chain.length} job(s) chained after it)` : '';
    if (requested?.kind === 'discard') logger.info(`Discarded ${record.job}${dropped}${requested.reason ? `: ${requested.reason}` : ''}`, context);
    else logger.info(`Processed ${record.job}`, context);
    await this.#emit(new JobProcessed({ ...this.#about(reserved, record), attempt: reserved.attempts, ms, discarded: requested?.kind === 'discard' }));
    if (acknowledged && next) {
      const queued = parseRecord(next)!;
      await this.#emit(new JobQueued({ connection: this.#deps.connection, queue: reserved.queue, job: queued.job, jobId: queued.uuid, delay: 0 }));
    }
    return 'processed';
  }

  /** The queues to take from now: the list as given, `*` expanded to the driver's queues (again after a second, or when none had a job). */
  #queues(list: readonly string[]): { current(): Promise<readonly string[]>; stale(): void } {
    if (!list.includes('*')) return { current: async () => list, stale: () => {} };
    if (!this.#deps.driver.queues) throw new Error('This queue driver cannot list its queues, so --queue=* is not possible — name the queues.');
    let expanded: readonly string[] | undefined;
    let at = 0;
    return {
      current: async () => {
        if (expanded && performance.now() - at < 1000) return expanded;
        const named = new Set(list.filter((queue) => queue !== '*'));
        const others = (await this.#deps.driver.queues()).filter((queue) => !named.has(queue));
        expanded = list.flatMap((queue) => (queue === '*' ? others : [queue]));
        at = performance.now();
        return expanded;
      },
      stale: () => {
        expanded = undefined;
      },
    };
  }

  /**
   * Watches the queues the worker does not take (`watchOtherQueues`): a queue with jobs ready at two looks in a row and none
   * running — nobody takes it — is named once in a warning. Two looks, because another worker that takes it may simply not
   * have claimed a job pushed a moment ago.
   */
  #others(options: WorkOptions): { look(): Promise<void> } {
    const every = options.watchOtherQueues ?? 60;
    if (every === false || options.queues.includes('*')) return { look: async () => {} };
    const taken = new Set(options.queues);
    const { driver, logger, connection } = this.#deps;
    let last = Number.NEGATIVE_INFINITY;
    let waiting = new Set<string>();
    const named = new Set<string>();
    return {
      look: async () => {
        if (performance.now() - last < every * 1000) return;
        last = performance.now();
        const now = new Set<string>();
        try {
          for (const queue of await driver.queues()) {
            if (taken.has(queue) || named.has(queue)) continue;
            const counts = driver.counts ? await driver.counts(queue) : { ready: await driver.size(queue), reserved: 0 };
            if (counts.ready > 0 && counts.reserved === 0) now.add(queue);
          }
        } catch (error) {
          logger.debug(`Could not look at the other queues: ${messageOf(error)}`);
          return;
        }
        for (const queue of now) {
          if (!waiting.has(queue)) continue;
          named.add(queue);
          logger.warn(
            `Jobs are waiting on the "${queue}" queue of the ${connection} connection, which this worker does not take (it takes ${options.queues.join(', ')}). ` +
              `If no other worker takes it, start this one with --queue=${[queue, ...options.queues].join(',')} (in priority order) or --queue=*.`,
            { queue, connection },
          );
        }
        waiting = now;
      },
    };
  }

  #about(reserved: ReservedJob, record: JobRecord) {
    return { connection: this.#deps.connection, queue: reserved.queue, job: record.job, jobId: record.uuid };
  }

  /** Frees a unique job's lock; a cache that fails is logged — the lock then expires after `uniqueFor`. */
  async #releaseUnique(record: JobRecord, moment: 'processing' | 'done'): Promise<void> {
    try {
      await releaseUnique(this.#deps.runner.cache, record, moment);
    } catch (error) {
      this.#deps.logger.warn(`Could not free the unique lock of ${record.job} (it expires after ${record.unique?.for}s): ${messageOf(error)}`, { job: record.job, jobId: record.uuid });
    }
  }

  /** A job event to the app's listeners — whose errors are logged, never the job's. */
  async #emit(event: JobEvent): Promise<void> {
    if (!this.#deps.events) return;
    try {
      await this.#deps.events(event);
    } catch (error) {
      this.#deps.logger.warn(`A listener of ${event.constructor.name} failed: ${messageOf(error)}`, { job: event.job, jobId: event.jobId });
    }
  }

  /**
   * One attempt, bounded: at the job's timeout `job.signal` aborts; a job that settles within the grace period after
   * that ends normally (an error from the abort counts as a failed attempt). One that does not is stuck — see `onStuck`.
   * A stop request gives the job `stopTimeout` seconds, then the attempt is interrupted.
   */
  async #attempt(
    reserved: ReservedJob,
    prepared: Extract<Prepared, { kind: 'ready' }>,
    options: Pick<WorkOptions, 'stopTimeout' | 'signal' | 'onStuck'>,
  ): Promise<{ kind: 'done'; requested: Requested | undefined } | { kind: 'error'; error: unknown } | { kind: 'interrupted' }> {
    const timeout = timeoutOf(prepared.job);
    const grace = options.stopTimeout ?? DEFAULT_STOP_TIMEOUT;
    const abort = new AbortController();
    const timers = new AbortController();
    const running = this.#deps.runner
      .run(prepared, {
        attempt: reserved.attempts,
        queue: reserved.queue,
        connection: this.#deps.connection,
        signal: abort.signal,
        ...(this.#deps.retryAfter === undefined ? {} : { retryAfter: this.#deps.retryAfter }),
      })
      .then(
        (requested) => ({ kind: 'done' as const, requested }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
    const wait = (ms: number) => sleep(ms, undefined, { signal: timers.signal }).then(
      () => true,
      () => false,
    );
    const timedOut = wait(timeout * 1000).then((elapsed) => {
      if (elapsed) abort.abort(new JobTimeoutError(`${prepared.record.job} timed out after ${timeout}s`));
      return elapsed;
    });
    const stuck = timedOut.then((elapsed) => (elapsed ? wait(grace * 1000) : false)).then((elapsed) => (elapsed ? ({ kind: 'stuck' } as const) : undefined));
    const stopped = stopRequested(options.signal, timers.signal).then((requested) => (requested ? wait(grace * 1000) : false)).then((elapsed) =>
      elapsed ? ({ kind: 'interrupted' } as const) : undefined,
    );

    try {
      type First = Awaited<typeof running> | { kind: 'stuck' } | { kind: 'interrupted' };
      const first = await Promise.race<First>([
        running,
        stuck.then((value) => value ?? never<First>()),
        stopped.then((value) => value ?? never<First>()),
      ]);
      if (first.kind === 'stuck') {
        const error = new JobStuckError(
          `${prepared.record.job} ignored its timeout of ${timeout}s and did not stop within ${grace}s more (job.signal aborted). ` +
            `Node cannot cancel a running promise, so this worker must end; the job runs again once retryAfter is over (attempt ${reserved.attempts} of ${prepared.record.tries}).`,
        );
        this.#deps.logger.error(error.message, { job: prepared.record.job, jobId: prepared.record.uuid, attempt: reserved.attempts });
        if (options.onStuck) options.onStuck(reserved, error);
        throw error;
      }
      if (first.kind === 'interrupted') abort.abort(new JobTimeoutError('the worker is stopping'));
      if (first.kind === 'error' && abort.signal.aborted && abort.signal.reason instanceof JobTimeoutError && !(first.error instanceof JobTimeoutError)) {
        // The job stopped because of its timeout: say so, with what it threw as the cause.
        return { kind: 'error', error: new JobTimeoutError(abort.signal.reason.message, { cause: first.error }) };
      }
      return first;
    } finally {
      timers.abort();
    }
  }

  async #retryOrFail(reserved: ReservedJob, record: JobRecord, error: unknown, ms: number | undefined, reason: 'error' | 'unknown'): Promise<Outcome> {
    const context = { job: record.job, jobId: record.uuid, attempt: reserved.attempts, queue: reserved.queue, ...(ms === undefined ? {} : { ms }) };
    if (reserved.attempts < record.tries) {
      const delay = backoffDelay(record.backoff, reserved.attempts);
      await this.#deps.driver.release(reserved, delay);
      this.#deps.logger.warn(`Attempt ${reserved.attempts} of ${record.tries} of ${record.job} failed, again in ${delay}s: ${messageOf(error)}`, context);
      await this.#emit(new JobReleased({ ...this.#about(reserved, record), attempt: reserved.attempts, delay, reason, ...(ms === undefined ? {} : { ms }) }));
      return 'released';
    }
    await this.#fail(reserved, record, error, record.tries > 1 ? ` after ${record.tries} attempts` : '', ms);
    return 'failed';
  }

  async #fail(reserved: ReservedJob, record: JobRecord | undefined, error: unknown, how: string, ms?: number): Promise<void> {
    const name = record?.job ?? '?';
    // Recorded first, then removed: a crash in between runs the job once more (at-least-once), it never vanishes.
    await this.#deps.failed.record({
      uuid: record?.uuid ?? crypto.randomUUID(),
      connection: this.#deps.connection,
      queue: reserved.queue,
      job: name,
      payload: reserved.payload,
      exception: describeError(error),
      failedAt: this.#deps.clock.now(),
    });
    const removed = await this.#deps.driver.fail(reserved);
    const dropped = record?.chain?.length ? ` — the ${record.chain.length} job(s) chained after it will not run` : '';
    this.#deps.logger.error(`Failed ${name}${how}${dropped}: ${messageOf(error)}`, {
      job: name,
      ...(record ? { jobId: record.uuid } : {}),
      attempt: reserved.attempts,
      queue: reserved.queue,
      ...(ms === undefined ? {} : { ms }),
    });
    if (!record) return;
    // A unique job that failed for good is done: a new one with its key may be queued.
    if (removed) await this.#releaseUnique(record, 'done');
    await this.#emit(new JobFailed({ ...this.#about(reserved, record), attempt: reserved.attempts, error: error instanceof Error ? error : new Error(String(error)) }));
  }
}

/** An error's message for a log line — redacted like the stored error (E105): a message may quote a secret. */
function messageOf(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
}

/** Resolves true when `signal` aborts (now or later), false when `cancel` aborts first. */
function stopRequested(signal: AbortSignal | undefined, cancel: AbortSignal): Promise<boolean> {
  if (!signal) return Promise.resolve(false);
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      signal.removeEventListener('abort', onStop);
      cancel.removeEventListener('abort', onCancel);
      resolve(value);
    };
    const onStop = () => done(true);
    const onCancel = () => done(false);
    signal.addEventListener('abort', onStop, { once: true });
    cancel.addEventListener('abort', onCancel, { once: true });
  });
}

/** A promise that never settles — for a branch of a race that must not win. */
function never<T>(): Promise<T> {
  return new Promise(() => {});
}

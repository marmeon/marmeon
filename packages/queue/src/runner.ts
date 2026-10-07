import { Application, durationToMilliseconds, outsideTransaction, runWithJob, type Container, type Duration, type StandardIssue } from '@marmeon/core';
import { channels, messageBase, trace, type QueueJobMessage } from '@marmeon/core/diagnostics';
import type { JobRecord, UniqueRecord } from './driver.ts';
import type { JobClass, JobContext, JobMiddleware } from './job.ts';
import { runOnce, type CacheSource } from './locks.ts';
import { QueueError, timeoutOf, type JobRegistry } from './registry.ts';

/** Encrypts and decrypts encrypted payloads (`static encrypted`, E105) — the app's `Encrypter`. */
export interface PayloadCipher {
  encrypt(plaintext: string, context: string): Promise<string>;
  decrypt(ciphertext: string, context: string): Promise<string>;
}

/** What a job's payload is bound to when encrypted: its name — a ciphertext cannot be moved to another job. */
export const cipherContext = (name: string) => `queue:${name}`;

/** The payload does not match the job's schema — at dispatch (a bug) or before it runs (a deploy changed the schema). */
export class JobPayloadError extends QueueError {
  override name = 'JobPayloadError';
  readonly issues: readonly StandardIssue[];

  constructor(message: string, issues: readonly StandardIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

/** `userId: Invalid type: Expected number but received "x"` — issues as one line. */
export function describeIssues(issues: readonly StandardIssue[]): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** Validates a payload against a job's schema; the schema's output, or a {@link JobPayloadError}. */
export async function validatePayload(job: JobClass, payload: unknown, when: 'dispatch' | 'run'): Promise<unknown> {
  const result = await job.schema['~standard'].validate(payload);
  if (result.issues) {
    const detail = describeIssues(result.issues);
    throw new JobPayloadError(
      when === 'dispatch' ? `The payload of ${job.job} does not match its schema: ${detail}` : `The payload no longer matches the schema of ${job.job}: ${detail}`,
      result.issues,
    );
  }
  return result.value;
}

/** The payload as the queue stores it: JSON — what a worker will see is checked now, at dispatch. */
export function toJson(job: JobClass, payload: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch (error) {
    throw new JobPayloadError(`The payload of ${job.job} cannot be stored as JSON: ${(error as Error).message}`);
  }
  if (json === undefined) throw new JobPayloadError(`The payload of ${job.job} cannot be stored as JSON (it is ${typeof payload}).`);
  return JSON.parse(json);
}

/** Seconds of a delay given as seconds or as a duration. */
export function delaySeconds(delay: number | Duration | undefined): number {
  if (delay === undefined) return 0;
  const seconds = typeof delay === 'number' ? delay : durationToMilliseconds(delay) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) throw new QueueError(`A delay must be seconds ≥ 0 (or a duration), not ${JSON.stringify(delay)}.`);
  return seconds;
}

/** A queued job, ready to run — or why it cannot. */
export type Prepared =
  | { readonly kind: 'ready'; readonly record: JobRecord; readonly job: JobClass; readonly payload: unknown }
  /** Never runnable: no job record, an unreadable or forged payload, a payload the schema rejects — failed at once. */
  | { readonly kind: 'poison'; readonly record: JobRecord | undefined; readonly reason: string }
  /** No class for this name in this app (yet — a rolling deploy): released with backoff until its tries are used up. */
  | { readonly kind: 'unknown'; readonly record: JobRecord };

const attempts = channels.tracing('queue.job');

/** The outcome a job chose through its `JobContext`, if any. */
export type Requested = { readonly kind: 'discard'; readonly reason: string | undefined } | { readonly kind: 'release'; readonly delay: number } | { readonly kind: 'fail'; readonly reason: string | Error };

/**
 * Turns a queued payload into a job to run, and runs it — shared by the worker and the `sync` connection: the class from
 * the registry, the payload decrypted (`static encrypted`) and checked against the schema again (E84), then a fresh
 * container scope per attempt (like a request) with the job's log context.
 */
export class JobRunner {
  readonly #container: Container;
  readonly #registry: JobRegistry;
  readonly #cipher: () => Promise<PayloadCipher>;
  readonly #cache: CacheSource;

  /** `cache`: the app's cache, for `job.once` and middleware like `withoutOverlapping` (asked for only when used). */
  constructor(container: Container, registry: JobRegistry, cipher: () => Promise<PayloadCipher>, cache?: CacheSource) {
    this.#container = container;
    this.#registry = registry;
    this.#cipher = cipher;
    this.#cache = cache ?? (() => Promise.reject(new QueueError('job.once() and job middleware need the app\'s cache — this runner was built without one.')));
  }

  /** The cache this runner gives jobs (`job.once`, middleware). */
  get cache(): CacheSource {
    return this.#cache;
  }

  async prepare(payload: string): Promise<Prepared> {
    const record = parseRecord(payload);
    if (!record) return { kind: 'poison', record: undefined, reason: 'The payload is not a job record (expected JSON with "job" and "data").' };
    const job = this.#registry.get(record.job);
    if (!job) return { kind: 'unknown', record };

    let data: unknown = record.data;
    if (job.encrypted && !record.encrypted) {
      return { kind: 'poison', record, reason: `${record.job} takes an encrypted payload (static encrypted), but this one is plain — not queued by this app.` };
    }
    if (record.encrypted) {
      try {
        if (typeof data !== 'string') throw new Error('not a ciphertext');
        data = JSON.parse(await (await this.#cipher()).decrypt(data, cipherContext(record.job)));
      } catch (error) {
        return { kind: 'poison', record, reason: `The encrypted payload of ${record.job} cannot be decrypted (was APP_KEY changed?): ${(error as Error).message}` };
      }
    }
    try {
      return { kind: 'ready', record, job, payload: await validatePayload(job, data, 'run') };
    } catch (error) {
      return { kind: 'poison', record, reason: (error as Error).message };
    }
  }

  /**
   * Runs one attempt in its own container scope, with `{ job, jobId, attempt }` as the log context. Resolves with what
   * the job asked for through its context (`discard`, `release`, `fail`), if anything; rejects with what it threw.
   * Traced on the `queue.job` channel while something listens (E118).
   */
  run(
    prepared: Extract<Prepared, { kind: 'ready' }>,
    attempt: { readonly attempt: number; readonly queue: string; readonly connection: string; readonly signal: AbortSignal; readonly retryAfter?: number },
  ): Promise<Requested | undefined> {
    if (!attempts.hasSubscribers || !this.#container.has(Application)) return this.#run(prepared, attempt);
    const { record } = prepared;
    const message: QueueJobMessage = {
      ...messageBase(this.#container.make(Application)),
      job: record.job,
      jobId: record.uuid,
      queue: attempt.queue,
      connection: attempt.connection,
      attempt: attempt.attempt,
      ...(record.requestId === undefined ? {} : { originRequestId: record.requestId }),
      ...(record.traceparent === undefined ? {} : { traceparent: record.traceparent }),
      payload: prepared.payload,
      encrypted: (prepared.job as { encrypted?: unknown }).encrypted === true,
    };
    return trace(attempts, message, () => this.#run(prepared, attempt), (ended, requested) => {
      ended.outcome = requested === undefined ? 'done' : requested.kind === 'discard' ? 'discarded' : requested.kind === 'release' ? 'released' : 'failed';
    });
  }

  /**
   * An attempt that cannot run — no class for its name (`unknown`), a payload that is not its job's (`poison`): `then` (the
   * worker's release or failure, with its log line) runs in the job's log context and, while something listens, as an attempt
   * on the `queue.job` channel that ends with `error` — so the devtools show it like any failed attempt, not only `failed_jobs`.
   */
  async unrunnable<T>(record: JobRecord, attempt: { readonly attempt: number; readonly queue: string; readonly connection: string }, error: Error, then: () => Promise<T>): Promise<T> {
    const info = { job: record.job, jobId: record.uuid, attempt: attempt.attempt, ...(record.requestId === undefined ? {} : { requestId: record.requestId }) };
    if (!attempts.hasSubscribers || !this.#container.has(Application)) return runWithJob(info, then);
    const message: QueueJobMessage = {
      ...messageBase(this.#container.make(Application)),
      job: record.job,
      jobId: record.uuid,
      queue: attempt.queue,
      connection: attempt.connection,
      attempt: attempt.attempt,
      ...(record.requestId === undefined ? {} : { originRequestId: record.requestId }),
      ...(record.traceparent === undefined ? {} : { traceparent: record.traceparent }),
      // As queued — not checked against any schema: shown only through the redactor, a ciphertext never (E125).
      ...(record.encrypted ? { encrypted: true } : { payload: record.data }),
    };
    let result: { value: T } | undefined;
    try {
      await trace(attempts, message, () =>
        runWithJob(info, async () => {
          result = { value: await then() };
          throw error;
        }),
      );
    } catch (thrown) {
      if (thrown !== error || !result) throw thrown;
    }
    return result!.value;
  }

  async #run(
    prepared: Extract<Prepared, { kind: 'ready' }>,
    attempt: { readonly attempt: number; readonly queue: string; readonly connection: string; readonly signal: AbortSignal; readonly retryAfter?: number },
  ): Promise<Requested | undefined> {
    const { record, job, payload } = prepared;
    let requested: Requested | undefined;
    const context: JobContext = {
      id: record.uuid,
      name: record.job,
      attempt: attempt.attempt,
      tries: record.tries,
      queue: attempt.queue,
      connection: attempt.connection,
      signal: attempt.signal,
      discard: (reason) => {
        requested ??= { kind: 'discard', reason };
      },
      release: (delay) => {
        requested ??= { kind: 'release', delay: delaySeconds(delay) };
      },
      fail: (reason) => {
        requested ??= { kind: 'fail', reason };
      },
      once: (key, fn, options = {}) =>
        runOnce(this.#cache, key, fn, { ...(options.for === undefined ? {} : { for: options.for }), lockSeconds: attempt.retryAfter ?? timeoutOf(job) + 60 }),
    };
    const middleware: readonly JobMiddleware[] = job.middleware ?? [];
    // A job is a boundary (E107): it never runs inside a transaction that was open where it was dispatched or worked on.
    await outsideTransaction(() => runWithJob({ job: record.job, jobId: record.uuid, attempt: attempt.attempt, ...(record.requestId === undefined ? {} : { requestId: record.requestId }) }, async () => {
      // One scope per attempt, like a request: scoped services (a Translator, a unit of work) start fresh each time.
      const scope = this.#container.createScope();
      const instance = scope.make(job as never) as { handle(payload: unknown, job: JobContext): unknown };
      // The job's middleware, first to last, around handle(): each may run the rest (`next()`) or end the attempt.
      const step = async (index: number): Promise<void> => {
        const layer = middleware[index];
        if (!layer) {
          await instance.handle(payload, context);
          return;
        }
        let called = false;
        await layer.handle(
          { payload, job: context, timeout: timeoutOf(job), retryAfter: attempt.retryAfter, cache: this.#cache },
          () => {
            if (called) throw new QueueError(`A middleware of ${record.job} called next() twice — the job would run twice.`);
            called = true;
            return step(index + 1);
          },
        );
      };
      await step(0);
    }));
    return requested;
  }
}

/** A stored payload as a job record — or undefined when it is none. */
export function parseRecord(payload: string): JobRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || typeof (value as { job?: unknown }).job !== 'string' || !('data' in value)) return undefined;
  const record = value as Partial<JobRecord> & { job: string; data: unknown };
  const tries = Number.isInteger(record.tries) && record.tries! >= 1 ? record.tries! : 1;
  const backoff = Array.isArray(record.backoff) && record.backoff.every((delay) => typeof delay === 'number' && delay >= 0) ? record.backoff : [];
  return {
    uuid: typeof record.uuid === 'string' && record.uuid ? record.uuid : crypto.randomUUID(),
    job: record.job,
    data: record.data,
    ...(record.encrypted === true ? { encrypted: true as const } : {}),
    tries,
    backoff,
    dispatchedAt: typeof record.dispatchedAt === 'number' ? record.dispatchedAt : 0,
    ...(isUnique(record.unique) ? { unique: record.unique } : {}),
    ...(Array.isArray(record.chain) && record.chain.length > 0 ? { chain: record.chain.map((link) => parseRecord(JSON.stringify(link))).filter((link) => link !== undefined) } : {}),
    ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
    ...(typeof record.traceparent === 'string' ? { traceparent: record.traceparent } : {}),
  };
}

function isUnique(value: unknown): value is UniqueRecord {
  const unique = value as Partial<UniqueRecord> | undefined;
  return (
    typeof unique === 'object' &&
    unique !== null &&
    typeof unique.lock === 'string' &&
    typeof unique.key === 'string' &&
    typeof unique.for === 'number' &&
    unique.for > 0 &&
    (unique.until === 'processing' || unique.until === 'done')
  );
}

/** The next job of a record's chain, as the queue stores it — carrying the rest of the chain; undefined at its end. */
export function nextInChain(record: JobRecord): string | undefined {
  const [next, ...rest] = record.chain ?? [];
  if (!next) return undefined;
  const { chain: _ignored, ...link } = next;
  return JSON.stringify(rest.length > 0 ? { ...link, chain: rest } : link);
}

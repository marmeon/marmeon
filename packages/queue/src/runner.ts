import { Application, durationToMilliseconds, outsideTransaction, type Container, type Duration, type StandardIssue } from '@marmeon/core';
import { messageBase, runWithJob, trace } from '@marmeon/core/internal';
import { channels, type QueueJobMessage } from '@marmeon/core/diagnostics';
import type { JobRecord, UniqueRecord } from './driver.ts';
import type { JobClass, JobContext, JobMiddleware } from './job.ts';
import { runOnce, type CacheSource } from './locks.ts';
import { QueueError, timeoutOf, type JobRegistry } from './registry.ts';

/** Encrypts and decrypts encrypted payloads (`static encrypted`) — the app's `Encrypter`. */
export interface PayloadCipher {
  encrypt(plaintext: string, context: string): Promise<string>;
  decrypt(ciphertext: string, context: string): Promise<string>;
}

/**
 * What a job's payload is bound to when encrypted: the record's version and the job's name — a ciphertext cannot be moved to
 * another job, nor read under a meaning a later version gives `data`.
 */
export const cipherContext = (name: string, version: number = RECORD_VERSION) => `queue:v${version}:${name}`;

/**
 * @internal A static method a framework job can have: `(container, payload)` → why this app cannot run the payload's target
 * (a queued listener it has no name for), or `undefined`. The record is then foreign, not failed.
 */
export const TARGET_UNKNOWN: unique symbol = Symbol('marmeon.queue.targetUnknown');

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
  /**
   * Never runnable, by any worker: no job record, no version, a broken chain, an unreadable or forged payload — failed at once.
   * `identity`: what a payload that is no record still says about itself, to label the failure.
   */
  | { readonly kind: 'poison'; readonly record: JobRecord | undefined; readonly reason: string; readonly identity?: RecordIdentity }
  /**
   * Not runnable by this worker, perhaps by another: a newer record version, no class for this name in this app, a payload the
   * schema rejects (a rolling deploy). Put back untouched until a worker can read it — see {@link FOREIGN_LIMIT_SECONDS}.
   */
  | { readonly kind: 'foreign'; readonly reason: string; readonly envelope: RecordEnvelope; readonly record: JobRecord | undefined };

/** What every version of the record keeps in place: the fields a worker may read of a record it does not understand. */
export interface RecordEnvelope {
  readonly v: number;
  readonly uuid: string | undefined;
  readonly job: string | undefined;
  /** Epoch ms; undefined when the record carries none a worker can trust. */
  readonly dispatchedAt: number | undefined;
  /** Epoch ms from which it could be claimed (its delay, a chain's turn, a retry); undefined when it carries none. */
  readonly availableAt: number | undefined;
}

/** What a payload that is no readable record says about itself — read only to label its failure, never to run it. */
export interface RecordIdentity {
  readonly uuid?: string;
  readonly job?: string;
  /** Its unique lock, if it names a readable one: freed when the record fails. */
  readonly unique?: UniqueRecord;
}

const attempts = channels.tracing('queue.job');

/** The outcome a job chose through its `JobContext`, if any. */
export type Requested = { readonly kind: 'discard'; readonly reason: string | undefined } | { readonly kind: 'release'; readonly delay: number } | { readonly kind: 'fail'; readonly reason: string | Error };

/**
 * Turns a queued payload into a job to run, and runs it — shared by the worker and the `sync` connection: the class from
 * the registry, the payload decrypted (`static encrypted`) and checked against the schema again, then a fresh
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
    const parsed = parseRecord(payload);
    if (parsed.kind === 'invalid') return { kind: 'poison', record: undefined, reason: parsed.reason, ...(parsed.identity ? { identity: parsed.identity } : {}) };
    if (parsed.kind === 'foreign') {
      return { kind: 'foreign', reason: `The record is version ${parsed.envelope.v}, newer than this worker reads (${supportedVersions()}).`, envelope: parsed.envelope, record: undefined };
    }
    const { record } = parsed;
    const job = this.#registry.get(record.job);
    if (!job) {
      return { kind: 'foreign', reason: `No job named "${record.job}" is registered in this app (a deploy in progress, or a module's jobs: [...] is missing it).`, envelope: envelopeOf(record), record };
    }

    let data: unknown = record.data;
    if (job.encrypted && !record.encrypted) {
      return { kind: 'poison', record, reason: `${record.job} takes an encrypted payload (static encrypted), but this one is plain — not queued by this app.` };
    }
    if (record.encrypted) {
      try {
        if (typeof data !== 'string') throw new Error('not a ciphertext');
        data = JSON.parse(await (await this.#cipher()).decrypt(data, cipherContext(record.job, record.v)));
      } catch (error) {
        return { kind: 'poison', record, reason: `The encrypted payload of ${record.job} cannot be decrypted (was APP_KEY changed?): ${(error as Error).message}` };
      }
    }
    try {
      const payload = await validatePayload(job, data, 'run');
      const unknown = (job as { [TARGET_UNKNOWN]?: (container: Container, payload: unknown) => string | undefined })[TARGET_UNKNOWN]?.(this.#container, payload);
      if (unknown) return { kind: 'foreign', reason: unknown, envelope: envelopeOf(record), record };
      return { kind: 'ready', record, job, payload };
    } catch (error) {
      // A newer release may have widened the schema (a new enum member): another worker may accept what this one rejects.
      return { kind: 'foreign', reason: (error as Error).message, envelope: envelopeOf(record), record };
    }
  }

  /**
   * Runs one attempt in its own container scope, with `{ job, jobId, attempt }` as the log context. Resolves with what
   * the job asked for through its context (`discard`, `release`, `fail`), if anything; rejects with what it threw.
   * Traced on the `queue.job` channel while something listens.
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
   * on the `queue.job` channel that ends with `error` — so the devtools show it like any failed attempt, not only `marmeon_failed_jobs`.
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
      // As queued — not checked against any schema: shown only through the redactor, a ciphertext never.
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
    // A job is a boundary: it never runs inside a transaction that was open where it was dispatched or worked on.
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

/** The version of the job record this release writes. */
export const RECORD_VERSION = 1;

/** How long a worker holds a record it cannot run before it gives up, measured from `dispatchedAt`. */
export const FOREIGN_LIMIT_SECONDS = 6 * 3600;

/** What a stored payload is to this worker. */
export type ParsedRecord =
  | { readonly kind: 'record'; readonly record: JobRecord }
  /** A version newer than any reader here: only the envelope was read. */
  | { readonly kind: 'foreign'; readonly envelope: RecordEnvelope }
  | { readonly kind: 'invalid'; readonly reason: string; readonly identity?: RecordIdentity };

type ReadResult = Extract<ParsedRecord, { kind: 'record' | 'invalid' }>;

/**
 * One reader per record version, each returning the record in the shape this release works with. A reader sees only objects
 * with a positive integer `v` equal to its key. A reader that maps a later version onto the v1 shape keeps the original `v` on
 * the record it returns: `cipherContext` binds an encrypted payload to it. @internal
 */
export const RECORD_READERS: Record<number, (value: Record<string, unknown>, depth?: number) => ReadResult> = {
  1: readV1,
};

const NOT_A_RECORD = 'The payload is not a job record (expected JSON with "job" and "data").';
const NO_VERSION = 'The record was queued by a release before job records carried a version — it cannot run; see docs/queues.md#deploying-while-jobs-wait.';

function supportedVersions(): string {
  return Object.keys(RECORD_READERS).join(', ');
}

function newestVersion(): number {
  return Math.max(...Object.keys(RECORD_READERS).map(Number));
}

/**
 * A stored payload as a job record, or why it is none: `foreign` when its version is newer than any reader here (never
 * interpreted — a newer release may have added a field that restricts the job), `invalid` when it has no version, one
 * that is no longer read, or cannot be read at all (a broken link of its chain included).
 */
export function parseRecord(payload: string): ParsedRecord {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { kind: 'invalid', reason: NOT_A_RECORD };
  }
  const read = readRecord(value, 0);
  if (read.kind !== 'invalid' || typeof value !== 'object' || value === null || Array.isArray(value)) return read;
  const identity = identityOf(value as Record<string, unknown>);
  return identity ? { ...read, identity } : read;
}

/** The id, name and unique lock a payload claims, as far as they are plainly readable. */
function identityOf(object: Record<string, unknown>): RecordIdentity | undefined {
  const unique = uniqueOf(object.unique);
  const identity = {
    ...(typeof object.uuid === 'string' && object.uuid ? { uuid: object.uuid } : {}),
    ...(typeof object.job === 'string' ? { job: object.job } : {}),
    ...(unique ? { unique } : {}),
  };
  return Object.keys(identity).length > 0 ? identity : undefined;
}

/** The deepest chain nesting a record may have — a bound on the recursion, far above anything the queue writes. */
const MAX_CHAIN_DEPTH = 1000;
/** The longest a record may be held: a dispatch time further ahead than this is a wrong clock or a forged record. */
export const CLOCK_SKEW_MS = 5 * 60_000;

function readRecord(value: unknown, depth: number): ParsedRecord {
  if (depth > MAX_CHAIN_DEPTH) return { kind: 'invalid', reason: `The record's chain is nested deeper than ${MAX_CHAIN_DEPTH} links.` };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'invalid', reason: NOT_A_RECORD };
  const object = value as Record<string, unknown>;
  const version = object.v;
  if (version === undefined) return typeof object.job === 'string' && 'data' in object ? { kind: 'invalid', reason: NO_VERSION } : { kind: 'invalid', reason: NOT_A_RECORD };
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return { kind: 'invalid', reason: `The record's version (v) is ${JSON.stringify(version)}, not a positive integer — it cannot run.` };
  }
  const reader = Object.hasOwn(RECORD_READERS, version) ? RECORD_READERS[version] : undefined;
  if (reader) return reader(object, depth);
  if (version > newestVersion()) {
    return {
      kind: 'foreign',
      envelope: {
        v: version,
        uuid: typeof object.uuid === 'string' && object.uuid ? object.uuid : undefined,
        job: typeof object.job === 'string' ? object.job : undefined,
        dispatchedAt: timeOf(object.dispatchedAt),
        availableAt: timeOf(object.availableAt),
      },
    };
  }
  return { kind: 'invalid', reason: `The record's version (${version}) is older than this release reads (${supportedVersions()}) — it cannot run.` };
}

function timeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function envelopeOf(record: JobRecord): RecordEnvelope {
  return { v: record.v, uuid: record.uuid, job: record.job, dispatchedAt: timeOf(record.dispatchedAt), availableAt: timeOf(record.availableAt) };
}

function readV1(record: Record<string, unknown>, depth = 0): ReadResult {
  if (typeof record.job !== 'string' || !('data' in record)) return { kind: 'invalid', reason: NOT_A_RECORD };
  const tries = Number.isInteger(record.tries) && (record.tries as number) >= 1 ? (record.tries as number) : 1;
  const backoff = Array.isArray(record.backoff) && record.backoff.every((delay) => typeof delay === 'number' && delay >= 0) ? (record.backoff as number[]) : [];
  let chain: JobRecord[] | undefined;
  if (Array.isArray(record.chain) && record.chain.length > 0) {
    chain = [];
    for (const [index, link] of record.chain.entries()) {
      const read = readRecord(link, depth + 1);
      if (read.kind !== 'record') {
        // A chain that silently lost a link would run the rest without it.
        return { kind: 'invalid', reason: `Link ${index + 1} of the record's chain cannot be read — ${read.kind === 'invalid' ? read.reason : `it is version ${read.envelope.v}`}` };
      }
      chain.push(read.record);
    }
  }
  const unique = uniqueOf(record.unique);
  return {
    kind: 'record',
    record: {
      v: 1,
      uuid: typeof record.uuid === 'string' && record.uuid ? record.uuid : crypto.randomUUID(),
      job: record.job,
      data: record.data,
      ...(record.encrypted === true ? { encrypted: true as const } : {}),
      tries,
      backoff,
      dispatchedAt: typeof record.dispatchedAt === 'number' ? record.dispatchedAt : 0,
      ...(timeOf(record.availableAt) === undefined ? {} : { availableAt: timeOf(record.availableAt)! }),
      ...(unique ? { unique } : {}),
      ...(chain ? { chain } : {}),
      ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
      ...(typeof record.traceparent === 'string' ? { traceparent: record.traceparent } : {}),
    },
  };
}

/** The unique lock of a record. An `until` this release does not know counts as `done`: the lock then holds longer, never shorter. */
function uniqueOf(value: unknown): UniqueRecord | undefined {
  const unique = value as Partial<UniqueRecord> | undefined;
  if (typeof unique !== 'object' || unique === null || typeof unique.lock !== 'string' || typeof unique.key !== 'string' || typeof unique.for !== 'number' || !(unique.for > 0)) return undefined;
  return { lock: unique.lock, key: unique.key, for: unique.for, until: unique.until === 'processing' ? 'processing' : 'done' };
}

/** The next job of a record's chain, as the queue stores it — carrying the rest of the chain; undefined at its end. */
export function nextInChain(record: JobRecord, now: number): string | undefined {
  const [next, ...rest] = record.chain ?? [];
  if (!next) return undefined;
  const { chain: _ignored, ...link } = next;
  // It becomes claimable now — a worker that cannot read it counts its time held from here, not from the chain's dispatch.
  return JSON.stringify(rest.length > 0 ? { ...link, availableAt: now, chain: rest } : { ...link, availableAt: now });
}

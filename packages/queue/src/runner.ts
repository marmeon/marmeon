import { durationToMilliseconds, outsideTransaction, runWithJob, type Container, type Duration, type StandardIssue } from '@bespokecore/core';
import type { JobRecord } from './driver.ts';
import type { JobClass, JobContext } from './job.ts';
import { QueueError, type JobRegistry } from './registry.ts';

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

  constructor(container: Container, registry: JobRegistry, cipher: () => Promise<PayloadCipher>) {
    this.#container = container;
    this.#registry = registry;
    this.#cipher = cipher;
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
   */
  async run(
    prepared: Extract<Prepared, { kind: 'ready' }>,
    attempt: { readonly attempt: number; readonly queue: string; readonly connection: string; readonly signal: AbortSignal },
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
    };
    // A job is a boundary (E107): it never runs inside a transaction that was open where it was dispatched or worked on.
    await outsideTransaction(() => runWithJob({ job: record.job, jobId: record.uuid, attempt: attempt.attempt }, async () => {
      // One scope per attempt, like a request: scoped services (a Translator, a unit of work) start fresh each time.
      const scope = this.#container.createScope();
      const instance = scope.make(job as never) as { handle(payload: unknown, job: JobContext): unknown };
      await instance.handle(payload, context);
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
  };
}

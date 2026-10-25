import type { Cache, Lock } from '@marmeon/cache';
import { durationToSeconds, type Duration, type StandardSchemaV1 } from '@marmeon/core';
import type { JobRecord, UniqueRecord } from './driver.ts';
import type { JobMiddleware, JobStatics, SchemaOutput, UniqueDispatchOptions } from './job.ts';
import { QueueError } from './registry.ts';

// Unique jobs, `withoutOverlapping` and `job.once`: locks and markers in the app's cache (@marmeon/cache, an
// optional peer — loaded where it is used). Every lock expires, so a crashed worker never blocks a key for good.

/** Seconds a unique lock holds at most, unless `uniqueFor` says otherwise. */
export const DEFAULT_UNIQUE_FOR = 3600;
/** Seconds a `job.once` marker is kept, unless `{ for }` says otherwise. */
export const DEFAULT_ONCE_FOR = 86_400;

/** The app's cache, for the queue's locks — or an error saying how to get one. */
export type CacheSource = () => Promise<Cache>;

function seconds(value: Duration, what: string): number {
  const result = durationToSeconds(value);
  if (!Number.isFinite(result) || result <= 0) throw new QueueError(`${what} must be seconds > 0 (or a duration), not ${JSON.stringify(value)}.`);
  return result;
}

/** What a unique dispatch stores in the job's record. */
export function uniqueRecord(job: JobStatics, options: UniqueDispatchOptions): UniqueRecord {
  if (typeof options.unique !== 'string' || options.unique === '') throw new QueueError(`unique must be a non-empty key, like \`stats:\${userId}\` (dispatching ${job.job}).`);
  const until = options.uniqueUntil ?? 'done';
  if (until !== 'processing' && until !== 'done') throw new QueueError(`uniqueUntil is 'processing' or 'done', not ${JSON.stringify(until)}.`);
  return {
    lock: `queue:unique:${job.job}:${options.unique}`,
    key: options.unique,
    for: options.uniqueFor === undefined ? DEFAULT_UNIQUE_FOR : seconds(options.uniqueFor, 'uniqueFor'),
    until,
  };
}

/** The unique lock of a job — its owner is the job's id, so any process can free it later (`cache.lock(name, s, owner)`). */
export function uniqueLock(cache: Cache, record: JobRecord & { unique: UniqueRecord }): Lock {
  return cache.lock(record.unique.lock, record.unique.for, record.uuid);
}

/** Frees the unique lock of a job (if it has one and still holds it) — when it starts (`processing`) or ends (`done`). */
export async function releaseUnique(cache: CacheSource, record: JobRecord | undefined, moment: 'processing' | 'done'): Promise<void> {
  if (!record?.unique) return;
  // A job unique until it is done keeps its lock while it starts (and while it retries).
  if (moment === 'processing' && record.unique.until !== 'processing') return;
  await uniqueLock(await cache(), record as JobRecord & { unique: UniqueRecord }).release();
}

/** Seconds until an attempt that found its `job.once` key busy runs again. */
export const ONCE_BUSY_DELAY = 5;

/**
 * Thrown when another attempt runs `job.once(key)` right now — the worker puts this attempt back for {@link ONCE_BUSY_DELAY}
 * seconds without counting it: it never got to run `fn`.
 */
export class JobOnceBusyError extends Error {
  override name = 'JobOnceBusyError';
}

/** `job.once(key, fn)`: `fn` only without a marker for `key`; the marker after `fn` succeeded (see `JobContext.once`). */
export async function runOnce(cache: CacheSource, key: string, fn: () => unknown, options: { for?: number; lockSeconds: number }): Promise<boolean> {
  if (typeof key !== 'string' || key === '') throw new QueueError('job.once() needs a key, like `welcome-mail:${user.id}`.');
  const ttl = options.for ?? DEFAULT_ONCE_FOR;
  if (!(ttl > 0)) throw new QueueError(`job.once(): { for } must be seconds > 0, not ${String(options.for)}.`);
  const store = await cache();
  const marker = `queue:once:${key}`;
  if (await store.has(marker)) return false;
  // Two attempts with the same key at once (a claim that expired while its worker still ran): only one runs `fn`.
  const lock = store.lock(`queue:once-lock:${key}`, options.lockSeconds);
  if (!(await lock.get())) throw new JobOnceBusyError(`job.once('${key}') is running in another attempt right now — this attempt runs again in ${ONCE_BUSY_DELAY}s, without using up a try.`);
  try {
    if (await store.has(marker)) return false;
    await fn();
    // The gap `once` admits: a crash right here — after `fn`, before the marker — runs `fn` again on the next attempt.
    await store.put(marker, 1, ttl);
    return true;
  } finally {
    await lock.release();
  }
}

/** Options of {@link withoutOverlapping}. */
export interface WithoutOverlappingOptions {
  /** Seconds until the job runs again when another holds the key (default 5). Each wait is an attempt: give the job `tries`. */
  readonly releaseAfter?: number;
  /** Seconds the lock holds at most (default: the connection's `retryAfterSeconds` — as long as a claim may run). */
  readonly expiresAfter?: number;
  /** Share the key with other jobs (default: per job — `stats:1` of one job does not block `stats:1` of another). */
  readonly shared?: boolean;
}

/**
 * Job middleware: never two attempts with the same key at once — on any worker (a lock in the app's cache). An attempt
 * that finds the key taken does not run; it goes back to the queue for `releaseAfter` seconds (an attempt counts). See
 * `docs/queues.md#job-middleware`.
 *
 * The type argument types the payload (the class is not known yet where its own static field is written). Only its
 * `schema` is looked at — a constraint on the whole job class would refer to the field being written.
 */
export function withoutOverlapping<J extends { readonly schema: StandardSchemaV1 } = { readonly schema: StandardSchemaV1 }>(
  key: string | ((payload: SchemaOutput<J['schema']>) => string),
  options: WithoutOverlappingOptions = {},
): JobMiddleware<SchemaOutput<J['schema']>> {
  const releaseAfter = options.releaseAfter ?? 5;
  if (!(releaseAfter >= 0)) throw new QueueError(`withoutOverlapping(): releaseAfter must be seconds ≥ 0, not ${String(options.releaseAfter)}.`);
  return {
    async handle(context, next) {
      const name = typeof key === 'string' ? key : key(context.payload);
      if (typeof name !== 'string' || name === '') throw new QueueError(`withoutOverlapping() of ${context.job.name} needs a key, not ${JSON.stringify(name)}.`);
      const lockName = options.shared ? `queue:overlap:${name}` : `queue:overlap:${context.job.name}:${name}`;
      const lock = (await context.cache()).lock(lockName, options.expiresAfter ?? context.retryAfterSeconds ?? context.timeout + 60);
      if (!(await lock.get())) {
        context.job.release(releaseAfter);
        return;
      }
      try {
        await next();
      } finally {
        await lock.release();
      }
    },
  };
}

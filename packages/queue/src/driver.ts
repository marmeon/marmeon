import type { Kysely } from '@bespokecore/database';

/**
 * A queued job as the queue stores it — the same for every driver (E83). `payload` is the JSON of a {@link JobRecord}.
 */
export interface QueuedJob {
  /** The driver's own id of this entry (a row id, a list entry) — not the job's id, which is in the payload. */
  readonly id: string;
  readonly queue: string;
  readonly payload: string;
}

/** A job a worker has claimed: `attempts` already counts this attempt. */
export interface ReservedJob extends QueuedJob {
  readonly attempts: number;
  /** When it was claimed (epoch ms, the queue's clock). */
  readonly reservedAt: number;
}

/**
 * The contract of a queue driver (E83): `sync` runs at once, `database` keeps jobs in the `jobs` table, `redis` (W6
 * step 4) in lists. A claim must be atomic across processes — two workers never hold the same job at once — and counts
 * the attempt. `ack`, `release` and `fail` act only on the claim they are given: if the claim expired (after
 * `retryAfter`) and another worker holds the job now, they change nothing and return false.
 */
export interface QueueDriver {
  /** Queues `payload` on `queue`, to be claimed no earlier than `delay` seconds from now. Returns the entry's id. */
  push(queue: string, payload: string, delay: number): Promise<string>;
  /**
   * Claims the next available job of the first queue (in order) that has one — also a job whose claim is older than
   * `retryAfter` (its worker died). Increments `attempts`. `undefined` when there is none.
   */
  reserve(queues: readonly string[]): Promise<ReservedJob | undefined>;
  /** Done: the job leaves the queue. */
  ack(job: ReservedJob): Promise<boolean>;
  /** Back to the queue, available again in `delay` seconds; the attempt stays counted. */
  release(job: ReservedJob, delay: number): Promise<boolean>;
  /** Leaves the queue for good — the worker has recorded it in the failed jobs first. */
  fail(job: ReservedJob): Promise<boolean>;
  /** Jobs waiting or running on `queue`. */
  size(queue: string): Promise<number>;
  /** Drivers that keep jobs in the database: the same driver writing through a transaction (E85). */
  using?(transaction: Kysely<any>): QueueDriver;
}

/**
 * The payload column: the job's identity, its data and the retry policy it was dispatched with (so a worker of an
 * older or newer release handles the retries the job was dispatched for — also when it does not know the job).
 */
export interface JobRecord {
  /** The job's id, stable over retries. */
  readonly uuid: string;
  /** `static job`. */
  readonly job: string;
  /** The payload — or, with `encrypted`, its ciphertext. */
  readonly data: unknown;
  readonly encrypted?: true;
  readonly tries: number;
  readonly backoff: readonly number[];
  /** When it was first dispatched (epoch ms). */
  readonly dispatchedAt: number;
}

/** Seconds before attempt `attempt + 1`, after attempt `attempt` failed: the attempt's entry of `backoff`, else its last. */
export function backoffDelay(backoff: readonly number[], attempt: number): number {
  if (backoff.length === 0) return 0;
  return backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0;
}

/** A failed job, as `failed_jobs` keeps it. */
export interface FailedJob {
  /** The job's id. */
  readonly uuid: string;
  readonly connection: string;
  readonly queue: string;
  /** The job's name (`static job`), or `?` when the payload was not even a job record. */
  readonly job: string;
  /** The payload as it was queued (encrypted payloads stay encrypted). */
  readonly payload: string;
  /** Why it failed: the error with its stack, redacted like a log entry. */
  readonly exception: string;
  /** Epoch ms. */
  readonly failedAt: number;
}

/** Where failed jobs go (E83): the `failed_jobs` table, or memory (tests). */
export interface FailedJobStore {
  /** Records a failure — again for the same job id replaces the entry. */
  record(job: FailedJob): Promise<void>;
  /** Newest first. */
  all(): Promise<FailedJob[]>;
  find(uuid: string): Promise<FailedJob | undefined>;
  forget(uuid: string): Promise<boolean>;
  /** Removes every failed job; returns how many. */
  flush(): Promise<number>;
  /** Removes failed jobs that failed before `before` (epoch ms); returns how many. */
  prune(before: number): Promise<number>;
}

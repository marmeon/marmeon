import type { Kysely } from '@marmeon/database';

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

/** A job to queue: what `push` takes, and what `ack` queues together with the acknowledgement (the next job of a chain). */
export interface QueuedPush {
  readonly queue: string;
  readonly payload: string;
  /** Seconds before it may be claimed. */
  readonly delay: number;
}

/** A queue's jobs by state — see {@link QueueDriver.counts}. */
export interface QueueCounts {
  readonly ready: number;
  readonly delayed: number;
  readonly reserved: number;
}

/**
 * The contract of a queue driver (E83): `sync` runs at once, `database` keeps jobs in the `jobs` table, `redis` in
 * lists. A claim must be atomic across processes — two workers never hold the same job at once — and counts the
 * attempt. `ack`, `release` and `fail` act only on the claim they are given: if the claim expired (after `retryAfter`)
 * and another worker holds the job now, they change nothing and return false.
 */
export interface QueueDriver {
  /** Queues `payload` on `queue`, to be claimed no earlier than `delay` seconds from now. Returns the entry's id. */
  push(queue: string, payload: string, delay: number): Promise<string>;
  /**
   * Claims the next available job of the first queue (in order) that has one — also a job whose claim is older than
   * `retryAfter` (its worker died). Increments `attempts`. `undefined` when there is none.
   */
  reserve(queues: readonly string[]): Promise<ReservedJob | undefined>;
  /**
   * Done: the job leaves the queue — and `next` (the rest of a chain) is queued in the same atomic step: both happen, or
   * neither (a database transaction, one Lua script). Only while the claim is this worker's: an expired claim queues
   * nothing — the worker that holds the job now hands the chain on.
   */
  ack(job: ReservedJob, next?: readonly QueuedPush[]): Promise<boolean>;
  /** Back to the queue, available again in `delay` seconds; the attempt stays counted. */
  release(job: ReservedJob, delay: number): Promise<boolean>;
  /** Leaves the queue for good — the worker has recorded it in the failed jobs first. */
  fail(job: ReservedJob): Promise<boolean>;
  /** Jobs waiting, delayed or running on `queue`. */
  size(queue: string): Promise<number>;
  /**
   * What `size` counts, split up — jobs ready to be claimed, delayed (not yet due, or released for a later retry) and reserved
   * (claimed by a worker: running, or an expired claim of a worker that died). Optional: for the devtools' queue view (W7).
   */
  counts?(queue: string): Promise<QueueCounts>;
  /** The queues that hold jobs (or held some — a driver may remember a queue after it ran empty), sorted — `--queue=*`, `queue:size`. */
  queues(): Promise<string[]>;
  /** Drivers that keep jobs in the database: the same driver writing through a transaction (E85). */
  using?(transaction: Kysely<any>): QueueDriver;
  /**
   * Drivers that keep jobs in the database: whether a push now writes into the ambient transaction of the current call
   * chain (E107) — then the job commits or rolls back with it. When this is missing or false, a dispatch inside a
   * transaction waits for its commit (`afterCommit`) and is dropped on a rollback.
   */
  joinsTransaction?(): Promise<boolean>;
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
  /** A unique job (`dispatch(…, { unique })`): the lock that keeps a second one off the queue, and when the worker frees it. */
  readonly unique?: UniqueRecord;
  /** The rest of its chain (`queue.chain([...])`): queued one after the other, each when the one before succeeded. */
  readonly chain?: readonly JobRecord[];
  /** The request it was dispatched in (its `x-request-id`, E131) — what the devtools and logs link the job to. */
  readonly requestId?: string;
  /** The trace context it was dispatched in (W3C `traceparent`, E131) — when a tracer (`@marmeon/otel`) gave one. */
  readonly traceparent?: string;
}

/** The unique lock of a job, as its record carries it: the lock's name (the job's id is its owner), how long it holds, until when. */
export interface UniqueRecord {
  /** The lock's name in the cache: `queue:unique:<job>:<key>`. */
  readonly lock: string;
  /** The key as dispatched (`unique: 'stats:7'`). */
  readonly key: string;
  /** Seconds the lock holds at most. */
  readonly for: number;
  /** `processing`: freed when a worker starts the job; `done`: when it leaves the queue (processed, failed, discarded). */
  readonly until: 'processing' | 'done';
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

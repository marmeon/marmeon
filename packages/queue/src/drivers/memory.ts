import { SystemClock, type Clock } from '@marmeon/core';
import type { FailedJob, FailedJobStore, QueueCounts, QueuedPush, QueueDriver, ReleaseOptions, ReservedJob } from '../driver.ts';

interface Entry {
  readonly id: string;
  readonly queue: string;
  readonly payload: string;
  attempts: number;
  reservedAt: number | undefined;
  availableAt: number;
}

/**
 * Jobs in this process's memory — what the `QueueFake` runs `app.queue.work()` on, and a driver for unit tests. Every
 * operation is synchronous, so it is atomic within the process; it is never shared between processes.
 */
export class MemoryQueueDriver implements QueueDriver {
  readonly #clock: Clock;
  readonly #retryAfter: number;
  readonly #entries: Entry[] = [];
  #next = 1;

  constructor(options: { clock?: Clock; retryAfter?: number } = {}) {
    this.#clock = options.clock ?? new SystemClock();
    this.#retryAfter = options.retryAfter ?? 90;
  }

  async push(queue: string, payload: string, delay: number): Promise<string> {
    const id = String(this.#next++);
    this.#entries.push({ id, queue, payload, attempts: 0, reservedAt: undefined, availableAt: this.#clock.now() + delay * 1000 });
    return id;
  }

  async reserve(queues: readonly string[]): Promise<ReservedJob | undefined> {
    const now = this.#clock.now();
    for (const queue of queues) {
      const entry = this.#entries.find(
        (candidate) =>
          candidate.queue === queue &&
          (candidate.reservedAt === undefined ? candidate.availableAt <= now : candidate.reservedAt <= now - this.#retryAfter * 1000),
      );
      if (!entry) continue;
      entry.attempts += 1;
      entry.reservedAt = now;
      return { id: entry.id, queue: entry.queue, payload: entry.payload, attempts: entry.attempts, reservedAt: now };
    }
    return undefined;
  }

  /** Like the database driver: an expired claim first, else the job that became due first (then the older one) — of any queue but `except`. */
  async reserveAny(except: readonly string[] = []): Promise<ReservedJob | undefined> {
    const now = this.#clock.now();
    const candidates = this.#entries.filter((entry) => !except.includes(entry.queue));
    const expired = candidates.filter((entry) => entry.reservedAt !== undefined && entry.reservedAt <= now - this.#retryAfter * 1000);
    const due = candidates.filter((entry) => entry.reservedAt === undefined && entry.availableAt <= now);
    // Stable sorts: entries are kept in the order they were pushed (the id's order).
    const entry = expired.sort((a, b) => a.reservedAt! - b.reservedAt! || a.availableAt - b.availableAt)[0] ?? due.sort((a, b) => a.availableAt - b.availableAt)[0];
    if (!entry) return undefined;
    entry.attempts += 1;
    entry.reservedAt = now;
    return { id: entry.id, queue: entry.queue, payload: entry.payload, attempts: entry.attempts, reservedAt: now };
  }

  async ack(job: ReservedJob, next: readonly QueuedPush[] = []): Promise<boolean> {
    if (!this.#remove(job)) return false;
    for (const push of next) await this.push(push.queue, push.payload, push.delay);
    return true;
  }

  async release(job: ReservedJob, delay: number, options: ReleaseOptions = {}): Promise<boolean> {
    const entry = this.#claimed(job);
    if (!entry) return false;
    if (options.refund) entry.attempts -= 1;
    entry.reservedAt = undefined;
    entry.availableAt = this.#clock.now() + delay * 1000;
    return true;
  }

  async fail(job: ReservedJob): Promise<boolean> {
    return this.#remove(job);
  }

  async size(queue: string): Promise<number> {
    return this.#entries.filter((entry) => entry.queue === queue).length;
  }

  async counts(queue: string): Promise<QueueCounts> {
    const now = this.#clock.now();
    const entries = this.#entries.filter((entry) => entry.queue === queue);
    const reserved = entries.filter((entry) => entry.reservedAt !== undefined).length;
    const ready = entries.filter((entry) => entry.reservedAt === undefined && entry.availableAt <= now).length;
    return { ready, delayed: entries.length - reserved - ready, reserved };
  }

  async queues(): Promise<string[]> {
    return [...new Set(this.#entries.map((entry) => entry.queue))].sort();
  }

  /** Every job waiting or running, oldest first (for the fake's inspection). */
  entries(): readonly { readonly id: string; readonly queue: string; readonly payload: string; readonly attempts: number; readonly reserved: boolean; readonly availableAt: number }[] {
    return this.#entries.map((entry) => ({ id: entry.id, queue: entry.queue, payload: entry.payload, attempts: entry.attempts, reserved: entry.reservedAt !== undefined, availableAt: entry.availableAt }));
  }

  #claimed(job: ReservedJob): Entry | undefined {
    return this.#entries.find((entry) => entry.id === job.id && entry.attempts === job.attempts && entry.reservedAt !== undefined);
  }

  #remove(job: ReservedJob): boolean {
    const entry = this.#claimed(job);
    if (!entry) return false;
    this.#entries.splice(this.#entries.indexOf(entry), 1);
    return true;
  }
}

/** Failed jobs in memory — the fake's, and a driver for tests. */
export class MemoryFailedJobStore implements FailedJobStore {
  readonly #jobs = new Map<string, FailedJob>();

  async record(job: FailedJob): Promise<void> {
    this.#jobs.delete(job.uuid);
    this.#jobs.set(job.uuid, job);
  }

  async all(): Promise<FailedJob[]> {
    return [...this.#jobs.values()].reverse();
  }

  async find(uuid: string): Promise<FailedJob | undefined> {
    return this.#jobs.get(uuid);
  }

  async forget(uuid: string): Promise<boolean> {
    return this.#jobs.delete(uuid);
  }

  async flush(): Promise<number> {
    const count = this.#jobs.size;
    this.#jobs.clear();
    return count;
  }

  async prune(before: number): Promise<number> {
    let count = 0;
    for (const [uuid, job] of this.#jobs) {
      if (job.failedAt < before) {
        this.#jobs.delete(uuid);
        count++;
      }
    }
    return count;
  }
}

/** `QUEUE_FAILED_DRIVER=null`: failed jobs are only logged (by the worker), never kept. */
export class NullFailedJobStore implements FailedJobStore {
  async record(): Promise<void> {}
  async all(): Promise<FailedJob[]> {
    return [];
  }
  async find(): Promise<FailedJob | undefined> {
    return undefined;
  }
  async forget(): Promise<boolean> {
    return false;
  }
  async flush(): Promise<number> {
    return 0;
  }
  async prune(): Promise<number> {
    return 0;
  }
}

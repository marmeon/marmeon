import type { QueueDriver, QueueDriverFactory, ReservedJob } from '@marmeon/queue';

interface Entry {
  id: string;
  queue: string;
  payload: string;
  attempts: number;
  availableAt: number;
  reservedAt?: number;
}

/** Jobs in this process's memory, claims honouring `retryAfter` — what a driver of your own has to do, in the smallest form. */
class ScratchQueueDriver implements QueueDriver {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #retryAfter: number;
  #next = 1;

  constructor(now: () => number, retryAfter: number) {
    this.#now = now;
    this.#retryAfter = retryAfter;
  }

  async push(queue: string, payload: string, delaySeconds: number): Promise<string> {
    const id = String(this.#next++);
    this.#entries.set(id, { id, queue, payload, attempts: 0, availableAt: this.#now() + delaySeconds * 1000 });
    return id;
  }

  async reserve(queues: readonly string[]): Promise<ReservedJob | undefined> {
    const now = this.#now();
    for (const queue of queues) {
      const entry = [...this.#entries.values()].find((e) => e.queue === queue && (e.reservedAt === undefined ? e.availableAt <= now : e.reservedAt <= now - this.#retryAfter * 1000));
      if (!entry) continue;
      entry.attempts++;
      entry.reservedAt = now;
      return { id: entry.id, queue, payload: entry.payload, attempts: entry.attempts, reservedAt: now };
    }
    return undefined;
  }

  /** The entry, if this claim is still the one holding it. */
  #claimed(job: ReservedJob): Entry | undefined {
    const entry = this.#entries.get(job.id);
    return entry?.reservedAt === job.reservedAt && entry.attempts === job.attempts ? entry : undefined;
  }

  async ack(job: ReservedJob, next: readonly { queue: string; payload: string; delaySeconds: number }[] = []): Promise<boolean> {
    if (!this.#claimed(job)) return false;
    this.#entries.delete(job.id);
    for (const { queue, payload, delaySeconds } of next) await this.push(queue, payload, delaySeconds);
    return true;
  }

  async release(job: ReservedJob, delaySeconds: number, options: { refund?: boolean } = {}): Promise<boolean> {
    const entry = this.#claimed(job);
    if (!entry) return false;
    delete entry.reservedAt;
    entry.availableAt = this.#now() + delaySeconds * 1000;
    if (options.refund) entry.attempts--;
    return true;
  }

  async fail(job: ReservedJob): Promise<boolean> {
    return this.#claimed(job) ? this.#entries.delete(job.id) : false;
  }

  async size(queue: string): Promise<number> {
    return [...this.#entries.values()].filter((e) => e.queue === queue).length;
  }

  async queues(): Promise<string[]> {
    return [...new Set([...this.#entries.values()].map((e) => e.queue))].sort();
  }
}

const scratch: QueueDriverFactory = ({ clock }) => ({ driver: new ScratchQueueDriver(() => clock.now(), 90), queue: 'default', retryAfter: 90 });

/** A queue driver of the app's own, `QUEUE_DRIVER=scratch` — a package brings its drivers the same way (docs/drivers.md#bringing-a-driver). */
export class ScratchQueueServiceProvider {
  static queueDrivers = { scratch };
}

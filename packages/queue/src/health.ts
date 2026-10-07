import type { HealthCheck } from '@marmeon/core';
import { QueueConfig } from './config.ts';
import { Queue } from './queue.ts';

/**
 * Readiness (E126): the default connection's driver answers — the size of its default queue, read from the jobs table or
 * Redis (`sync` has nothing to reach). Registered by the `QueueServiceProvider` for `/up/ready`.
 */
export class QueueHealthCheck implements HealthCheck {
  static check = 'queue';

  readonly #queue: Queue;
  readonly #config: QueueConfig;

  constructor(queue: Queue, config: QueueConfig) {
    this.#queue = queue;
    this.#config = config;
  }

  async handle(): Promise<string> {
    const waiting = await this.#queue.size();
    return `${this.#config.default}, ${waiting} waiting`;
  }
}

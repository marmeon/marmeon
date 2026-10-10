import type { HealthCheck } from '@marmeon/core';
import { RedisConnections } from './connections.ts';

/**
 * Readiness: every Redis connection the app uses (one a driver asked for — the cache, sessions, the queue, live
 * hints) answers `PING`. A configured connection nothing uses is not checked: `REDIS_URL` has a default, and an app on the
 * database drivers must not be "not ready" for a Redis it never talks to. Registered by the `RedisServiceProvider`.
 */
export class RedisHealthCheck implements HealthCheck {
  static check = 'redis';

  readonly #redis: RedisConnections;

  constructor(redis: RedisConnections) {
    this.#redis = redis;
  }

  async handle(): Promise<string> {
    const names = this.#redis.inUse();
    if (names.length === 0) return 'no connection in use';
    const failed: string[] = [];
    const errors: unknown[] = [];
    await Promise.all(
      names.map(async (name) => {
        try {
          const answer = await this.#redis.get(name).command(['PING']);
          if (answer !== 'PONG') throw new Error(`PING answered ${JSON.stringify(answer)}`);
        } catch (error) {
          failed.push(name);
          errors.push(error);
        }
      }),
    );
    if (failed.length > 0) throw new AggregateError(errors, `The Redis connection${failed.length > 1 ? 's' : ''} ${failed.map((name) => `"${name}"`).join(', ')} failed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`);
    return names.join(', ');
  }
}

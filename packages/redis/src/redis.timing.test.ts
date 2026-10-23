import type { Logger } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { RedisConnections } from './connections.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

// Wall-clock tests run alone and last (the `timing` project). `redis.test.ts` proves what the refusal says; here is how fast.
describe('RedisConnections without a server', () => {
  it('fails fast when Redis is unreachable — no request waits for a reconnect loop', async () => {
    const unreachable = new RedisConnections({ connections: { default: { url: 'redis://127.0.0.1:1', prefix: 'x:' } }, logger: silent });
    const started = performance.now();
    await expect(unreachable.get().command(['PING'])).rejects.toThrow(/Could not connect to Redis/);
    expect(performance.now() - started).toBeLessThan(2_000);
    await unreachable.close();
  });
});

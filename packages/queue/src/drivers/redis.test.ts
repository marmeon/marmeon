import { createApplication, Logger } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { RedisServiceProvider, type RedisConnection } from '@marmeon/redis';
import { CliServiceProvider } from 'marmeon';
import { describe, expect, it } from 'vitest';
import { QueueServiceProvider, QueueSetupError } from '../index.ts';
import { queueUnderTest, redisConnections, REDIS_URL, silent } from '../__fixtures__/targets.ts';
import { RedisQueueDriver } from './redis.ts';

// A connection that records what is asked of it: a refused name never reaches Redis.
function untouched(): { connection: RedisConnection; calls: unknown[] } {
  const calls: unknown[] = [];
  const connection = new Proxy({} as RedisConnection, {
    get: (_, property) => {
      calls.push(property);
      throw new Error(`Redis was used (${String(property)})`);
    },
  });
  return { connection, calls };
}

describe('the names of redis queues', () => {
  it.each([':delayed', ':reserved'])('refuses a name ending in %s, whose keys belong to another queue', async (ending) => {
    const { connection, calls } = untouched();
    const driver = new RedisQueueDriver(connection, { retryAfterSeconds: 90 });
    const queue = `a${ending}`;
    const job = { id: 'x', queue, payload: 'p', attempts: 1, reservedAt: 0 };
    const message = new RegExp(`queue "${queue}".*ends in "${ending}".*queue "a"`);
    await expect(driver.push(queue, 'p', 0)).rejects.toThrow(message);
    await expect(driver.reserve(['default', queue])).rejects.toThrow(message);
    await expect(driver.size(queue)).rejects.toThrow(message);
    await expect(driver.counts(queue)).rejects.toThrow(message);
    await expect(driver.ack(job)).rejects.toThrow(message);
    await expect(driver.ack({ ...job, queue: 'a' }, [{ queue, payload: 'p', delaySeconds: 0 }])).rejects.toThrow(message);
    await expect(driver.release(job, 0)).rejects.toThrow(message);
    await expect(driver.fail(job)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it('accepts a name that only contains the words', async () => {
    const { connection } = untouched();
    const driver = new RedisQueueDriver(connection, { retryAfterSeconds: 90 });
    // Past the name check, the stub connection is what fails.
    await expect(driver.push('delayed', 'p', 0)).rejects.toThrow('Redis was used');
    await expect(driver.push('a:delayed:x', 'p', 0)).rejects.toThrow('Redis was used');
  });

  it('lists and round-robins only the queues it accepts', async () => {
    const touched: string[] = [];
    const connection = {
      key: (name: string) => name,
      command: async (command: string[]) => {
        touched.push(...command);
        return command[0] === 'SMEMBERS' ? ['a:delayed', 'b', 'c:reserved'] : null;
      },
      run: async (_script: unknown, keys: string[]) => {
        touched.push(...keys);
        return null;
      },
    } as unknown as RedisConnection;
    const driver = new RedisQueueDriver(connection, { retryAfterSeconds: 90 });
    expect(await driver.queues()).toEqual(['b']);
    expect(await driver.reserveAny()).toBeUndefined();
    expect(touched.filter((part) => part.includes('a:delayed') || part.includes('c:reserved'))).toEqual([]);
    expect(touched.some((part) => part.includes('queues:b'))).toBe(true);
  });

  it('stops the app at its start when the default queue of the redis connection has a refused name', async () => {
    const start = createApplication(
      { root: '/tmp', discover: false, providers: [CliServiceProvider, DatabaseServiceProvider, RedisServiceProvider, EncryptionServiceProvider, QueueServiceProvider] },
      {
        env: { DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=', NODE_ENV: 'test', QUEUE_DRIVER: 'redis', REDIS_URL: 'redis://127.0.0.1:1', REDIS_PREFIX: 'refused:', QUEUE_REDIS_QUEUE: 'jobs:delayed' },
        override: (container) => container.instance(Logger, silent),
      },
    );
    await expect(start).rejects.toBeInstanceOf(QueueSetupError);
    await expect(start).rejects.toThrow(/"jobs:delayed".*Set QUEUE_REDIS_QUEUE to another name/);
  });

  // Needs Redis (`pnpm test:redis`).
  it.skipIf(!REDIS_URL)('keeps the jobs of `a` apart from a queue named `a:delayed`', async () => {
    const { driver, target, close } = await queueUnderTest('redis');
    try {
      await driver.push('a', 'later', 60);
      await expect(driver.push('a:delayed', 'x', 0)).rejects.toThrow('ends in ":delayed"');
      expect(await driver.size('a')).toBe(1);
      expect(await driver.queues()).toEqual(['a']);
      // A name from before the rule is in the registry: neither listed nor taken.
      const redis = redisConnections(REDIS_URL!, target.kind === 'redis' ? target.prefix : '');
      await redis.get().command(['SADD', redis.get().key('queues'), 'x:delayed']);
      await redis.close();
      expect(await driver.queues()).toEqual(['a']);
      expect(await driver.reserveAny!()).toBeUndefined();
    } finally {
      await close();
    }
  });
});

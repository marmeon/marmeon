import { createApplication, type Logger } from '@marmeon/core';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { defineRedisScript, RedisConnections } from './connections.ts';
import { defineRedisConnection, RedisConfig, RedisServiceProvider } from './index.ts';

/** Redis runs when `MARMEON_TEST_REDIS_URL` is set (`docker compose up -d`, then `pnpm test:redis`). */
const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL;

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function connections(prefix = `marmeon-test-${crypto.randomUUID().slice(0, 8)}:`, url = REDIS_URL ?? 'redis://127.0.0.1:1') {
  return new RedisConnections({ connections: { default: { url, prefix } }, logger: silent });
}

describe('RedisConnections without a server', () => {
  it('loads its client at the start without connecting — node-redis comes with this package (E198), the app installs nothing else', async () => {
    const redis = connections('x:', 'redis://127.0.0.1:1');
    await expect(redis.verify()).resolves.toBeUndefined();
    await redis.close();
  });

  it('fails fast when Redis is unreachable — no request waits for a reconnect loop', async () => {
    const unreachable = connections('x:', 'redis://127.0.0.1:1');
    const started = performance.now();
    await expect(unreachable.get().command(['PING'])).rejects.toThrow(/Could not connect to Redis "default" \(redis:\/\/127\.0\.0\.1:1\)/);
    expect(performance.now() - started).toBeLessThan(2_000);
    await unreachable.close();
  });

  it('knows its connections by name and prefixes keys', async () => {
    const redis = connections('app:');
    expect(redis.get().key('cache:hits')).toBe('app:cache:hits');
    expect(redis.get()).toBe(redis.get('default'));
    expect(() => redis.get('queue')).toThrow(/Redis connection "queue" is not configured\. Known: default\. Add one with defineRedisConnection\('queue', …\)/);
    await redis.close();
    expect(() => redis.get()).toThrow(/closed/);
  });

  it('configures the default from REDIS_URL, prefixed with the app name unless REDIS_PREFIX says otherwise', async () => {
    const Queue = defineRedisConnection('queue', {
      env: v.object({ QUEUE_REDIS_URL: v.string() }),
      resolve: (env) => ({ url: env.QUEUE_REDIS_URL, prefix: 'q:' }),
    });
    const app = await createApplication({
      root: import.meta.dirname,
      discover: false,
      env: { APP_NAME: 'My Shop (EU)', REDIS_URL: 'redis://cache.internal:6380/2', QUEUE_REDIS_URL: 'redis://queue.internal:6379' },
      providers: [RedisServiceProvider],
      config: [Queue],
    });
    expect(app.container.make(RedisConfig).default).toEqual({ url: 'redis://cache.internal:6380/2', prefix: 'my-shop-eu:' });
    const redis = app.container.make(RedisConnections);
    expect(redis.names()).toEqual(['default', 'queue']);
    expect(redis.options('queue')).toEqual({ url: 'redis://queue.internal:6379', prefix: 'q:' });
    await app.shutdown(); // nothing was opened: nothing to wait for
    expect(() => defineRedisConnection('default', { env: v.object({}), resolve: () => ({ url: 'redis://x', prefix: '' }) })).toThrow(/REDIS_URL/);
  });

  it('rejects a REDIS_URL that is not one', async () => {
    await expect(
      createApplication({ root: import.meta.dirname, discover: false, env: { REDIS_URL: 'localhost:6379' }, providers: [RedisServiceProvider] }),
    ).rejects.toThrow(/REDIS_URL.*redis:\/\//s);
  });
});

describe.runIf(REDIS_URL)('RedisConnections on Redis', () => {
  it('runs raw commands, opened on the first one', async () => {
    const redis = connections();
    const connection = redis.get();
    expect(await connection.command(['SET', connection.key('k'), 'v', 'NX', 'PX', 5_000])).toBe('OK');
    expect(await connection.command(['SET', connection.key('k'), 'w', 'NX'])).toBeNull();
    expect(await connection.command(['GET', connection.key('k')])).toBe('v');
    await connection.command(['DEL', connection.key('k')]);
    await redis.close();
    await expect(connection.command(['PING'])).rejects.toThrow(/closed/);
  });

  it('runs named scripts by hash — and loads them when Redis does not know them (after a restart, SCRIPT FLUSH)', async () => {
    const redis = connections();
    const connection = redis.get();
    const double = defineRedisScript('test.double', `return tonumber(ARGV[1]) * 2 + #KEYS`);
    await connection.command(['SCRIPT', 'FLUSH']);
    expect(await connection.run(double, [connection.key('a')], [20])).toBe(41); // NOSCRIPT → EVAL
    expect(await connection.command(['SCRIPT', 'EXISTS', double.sha])).toEqual([1]);
    expect(await connection.run(double, [], [5])).toBe(10); // EVALSHA
    await redis.close();
  });

  it('subscribes on a duplicate connection — closed with the others', async () => {
    const redis = connections();
    const publisher = redis.get();
    const subscriber = publisher.duplicate();
    const received: string[] = [];
    const arrived = new Promise<void>((resolve) => {
      void subscriber.subscribe(publisher.key('news'), (message) => {
        received.push(message);
        resolve();
      });
    });
    // The subscription is set up before the publish is answered: retry until a subscriber counts it.
    for (let tries = 0; (await publisher.command<number>(['PUBLISH', publisher.key('news'), 'hello'])) === 0 && tries < 50; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await arrived;
    expect(received[0]).toBe('hello');
    await redis.close();
    await expect(subscriber.command(['PING'])).rejects.toThrow(/closed/);
  });
});

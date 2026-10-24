import { createApplication, env, type Logger } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { defineRedisScript, describeRedisUrl, RedisConnections } from './connections.ts';
import { defineRedisConnection, RedisConfig, RedisServiceProvider } from './index.ts';

/** Redis runs when `MARMEON_TEST_REDIS_URL` is set (`docker compose up -d`, then `pnpm test:redis`). */
const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL;

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function connections(prefix = `marmeon-test-${crypto.randomUUID().slice(0, 8)}:`, url = REDIS_URL ?? 'redis://127.0.0.1:1') {
  return new RedisConnections({ connections: { default: { url, prefix } }, logger: silent });
}

describe('describeRedisUrl', () => {
  it.each([
    ['redis://:p4ss@cache:6379/0', 'redis://:***@cache:6379/0'],
    ['redis://user:p%40ss%2Fw0rd@cache:6379', 'redis://user:***@cache:6379'],
    ['redis://:p@ss/w0rd@cache:6379/1', 'redis://:***@cache:6379/1'],
    ['redis://:pa/ss@[::1]:6379', '(invalid URL)'],
    ['redis://token_svc:pw@pass-cache:6379', 'redis://token_svc:***@pass-cache:6379'],
    ['redis://cache:6379/0', 'redis://cache:6379/0'],
  ])('masks the password of %s whole', (url, expected) => {
    expect(describeRedisUrl(url)).toBe(expected);
  });
});

describe('RedisConnections without a server', () => {
  it('loads its client at the start without connecting — node-redis comes with this package, the app installs nothing else', async () => {
    const redis = connections('x:', 'redis://127.0.0.1:1');
    await expect(redis.verify()).resolves.toBeUndefined();
    await redis.close();
  });

  it('refuses a command with the cause when Redis is unreachable', async () => {
    const unreachable = connections('x:', 'redis://127.0.0.1:1');
    await expect(unreachable.get().command(['PING'])).rejects.toThrow(/Could not connect to Redis "default" \(redis:\/\/127\.0\.0\.1:1\)/);
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
      env: env({ QUEUE_REDIS_URL: env.string() }),
      resolve: (e) => ({ url: e.QUEUE_REDIS_URL, prefix: 'q:' }),
    });
    const app = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [RedisServiceProvider],
      config: [Queue],
    }, { env: { APP_NAME: 'My Shop (EU)', REDIS_URL: 'redis://cache.internal:6380/2', QUEUE_REDIS_URL: 'redis://queue.internal:6379' } });
    expect(app.container.make(RedisConfig).default).toEqual({ url: 'redis://cache.internal:6380/2', prefix: 'my-shop-eu:' });
    const redis = app.container.make(RedisConnections);
    expect(redis.names()).toEqual(['default', 'queue']);
    expect(redis.options('queue')).toEqual({ url: 'redis://queue.internal:6379', prefix: 'q:' });
    await app.shutdown(); // nothing was opened: nothing to wait for
    expect(() => defineRedisConnection('default', { env: env({}), resolve: () => ({ url: 'redis://x', prefix: '' }) })).toThrow(/REDIS_URL/);
  });

  it('takes an empty REDIS_PREFIX as a missing one — the app name, never a key without a prefix', async () => {
    const prefix = async (variables: Record<string, string>) =>
      (await createApplication({ root: import.meta.dirname, discover: false, providers: [RedisServiceProvider] }, { env: { APP_NAME: 'Shop', ...variables } })).container.make(RedisConfig).default.prefix;
    expect(await prefix({ REDIS_PREFIX: '' })).toBe('shop:');
    expect(await prefix({ REDIS_PREFIX: 'tenant-a:' })).toBe('tenant-a:');
  });

  it('takes the prefix from REDIS_PREFIX alone, or from APP_NAME alone', async () => {
    const prefix = async (variables: Record<string, string>) =>
      (await createApplication({ root: import.meta.dirname, discover: false, providers: [RedisServiceProvider] }, { env: variables })).container.make(RedisConfig).default.prefix;
    expect(await prefix({ REDIS_PREFIX: 'tenant-a:' })).toBe('tenant-a:');
    expect(await prefix({ APP_NAME: 'My App' })).toBe('my-app:');
    expect(await prefix({ APP_NAME: 'My App', REDIS_PREFIX: 'x:' })).toBe('x:');
  });

  it('stops at the start with neither REDIS_PREFIX nor a usable APP_NAME — never a silent "marmeon:"', async () => {
    const start = (variables: Record<string, string>) => createApplication({ root: import.meta.dirname, discover: false, providers: [RedisServiceProvider] }, { env: variables });
    const unusable: Record<string, string>[] = [{}, { APP_NAME: '' }, { REDIS_PREFIX: '' }, { APP_NAME: '', REDIS_PREFIX: '' }, { APP_NAME: '!!!' }];
    for (const variables of unusable) {
      await expect(start(variables), JSON.stringify(variables)).rejects.toThrow(/REDIS_PREFIX.*APP_NAME.*share their keys/s);
    }
  });

  it('rejects a REDIS_URL that is not one', async () => {
    await expect(
      createApplication({ root: import.meta.dirname, discover: false, providers: [RedisServiceProvider] }, { env: { REDIS_URL: 'localhost:6379', APP_NAME: 'Shop' } }),
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

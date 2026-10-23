import { createApplication, type Logger } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { RedisConnections, RedisServiceProvider } from '@marmeon/redis';
import { describe, expect, it } from 'vitest';
import { LiveServiceProvider } from './index.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/** Redis connections whose client cannot load — a broken install of the driver. */
class BrokenClient extends RedisConnections {
  override async verify(): Promise<void> {
    throw new Error('Cannot find package "redis" (a broken install)');
  }
}

describe('LIVE_DRIVER=redis', () => {
  it('loads the Redis client when the app starts — a broken install fails the start, not the first hint', async () => {
    const started = createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, RedisServiceProvider, LiveServiceProvider],
    }, { env: { APP_KEY: generateKey(), LIVE_DRIVER: 'redis', REDIS_URL: 'redis://127.0.0.1:1', APP_NAME: 'Live' }, override: (container) => container.instance(RedisConnections, new BrokenClient({ connections: { default: { url: 'redis://127.0.0.1:1', prefix: 'x:' } }, logger: silent })) });
    const outcome = await started.then(
      async (app) => {
        await app.shutdown();
        return 'started';
      },
      (error: Error) => error.message,
    );
    expect(outcome).toBe('Cannot find package "redis" (a broken install)');
  });
});

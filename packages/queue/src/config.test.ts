import { ConfigError, resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { QueueConfig } from './config.ts';

const resolve = async (env: Record<string, string>) => (await resolveConfig([QueueConfig], env)).get(QueueConfig) as QueueConfig;

describe('QueueConfig: variable names', () => {
  it('reads the driver, the connections and the seconds of a claim by their new names', async () => {
    const config = await resolve({
      QUEUE_DRIVER: 'redis',
      QUEUE_DATABASE_CONNECTION: 'jobs',
      QUEUE_DATABASE_QUEUE: 'mail',
      QUEUE_DATABASE_RETRY_AFTER_SECONDS: '120',
      QUEUE_REDIS_CONNECTION: 'cache',
      QUEUE_REDIS_QUEUE: 'urgent',
      QUEUE_REDIS_RETRY_AFTER_SECONDS: '30',
    });
    expect(config.default).toBe('redis');
    expect(config.connections.database).toEqual({ driver: 'database', queue: 'mail', connection: 'jobs', retryAfterSeconds: 120 });
    expect(config.connections.redis).toEqual({ driver: 'redis', queue: 'urgent', connection: 'cache', retryAfterSeconds: 30 });
    expect(config.failed.connection).toBe('jobs');
  });

  it('names the new variable in the message of a bad number of seconds', async () => {
    await expect(resolve({ QUEUE_DATABASE_RETRY_AFTER_SECONDS: 'soon' })).rejects.toThrow('QUEUE_DATABASE_RETRY_AFTER_SECONDS must be a number of seconds');
    await expect(resolve({ QUEUE_REDIS_RETRY_AFTER_SECONDS: 'soon' })).rejects.toThrow('QUEUE_REDIS_RETRY_AFTER_SECONDS must be a number of seconds');
  });

  it.each([
    ['QUEUE_CONNECTION', 'QUEUE_DRIVER', 'redis'],
    ['DB_QUEUE_CONNECTION', 'QUEUE_DATABASE_CONNECTION', 'default'],
    ['DB_QUEUE', 'QUEUE_DATABASE_QUEUE', 'mail'],
    ['DB_QUEUE_RETRY_AFTER', 'QUEUE_DATABASE_RETRY_AFTER_SECONDS', '90'],
    ['REDIS_QUEUE_CONNECTION', 'QUEUE_REDIS_CONNECTION', 'default'],
    ['REDIS_QUEUE', 'QUEUE_REDIS_QUEUE', 'mail'],
    ['REDIS_QUEUE_RETRY_AFTER', 'QUEUE_REDIS_RETRY_AFTER_SECONDS', '90'],
  ])('stops the start when %s is set, naming %s', async (from, to, value) => {
    const error = await resolve({ [from]: value }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(`${from} was renamed ${to}`);
  });
});

import { ConfigError, resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { LiveConfig } from './config.ts';

const resolve = async (env: Record<string, string>) => (await resolveConfig([LiveConfig], env)).get(LiveConfig) as LiveConfig;

describe('LiveConfig: variable names', () => {
  it('keeps the defaults under the new names', async () => {
    expect(await resolve({})).toMatchObject({ driver: 'memory', connection: 'default', redisConnection: 'default', pollMs: 500, heartbeatSeconds: 20, retryMs: 3000 });
  });

  it('reads the connection, the heartbeat in seconds and the retry in milliseconds by their new names', async () => {
    expect(await resolve({ LIVE_CONNECTION: 'live', LIVE_HEARTBEAT_SECONDS: '5', LIVE_RETRY_MILLISECONDS: '500' })).toMatchObject({ connection: 'live', redisConnection: 'live', heartbeatSeconds: 5, retryMs: 500 });
  });

  it('keeps the bounds of the heartbeat and the retry', async () => {
    await expect(resolve({ LIVE_HEARTBEAT_SECONDS: '301' })).rejects.toThrow(/LIVE_HEARTBEAT_SECONDS/);
    await expect(resolve({ LIVE_RETRY_MILLISECONDS: '99' })).rejects.toThrow(/LIVE_RETRY_MILLISECONDS/);
  });

  it('takes the database driver, its connection and its poll interval', async () => {
    expect(await resolve({ LIVE_DRIVER: 'database', LIVE_CONNECTION: 'system', LIVE_POLL_MILLISECONDS: '250' })).toMatchObject({ driver: 'database', connection: 'system', redisConnection: 'system', pollMs: 250 });
    await expect(resolve({ LIVE_DRIVER: 'mysql' })).rejects.toThrow(/Expected memory, database or redis/);
  });

  it('keeps the poll interval between 50 and 10 000 milliseconds', async () => {
    await expect(resolve({ LIVE_POLL_MILLISECONDS: '49' })).rejects.toThrow(/LIVE_POLL_MILLISECONDS/);
    await expect(resolve({ LIVE_POLL_MILLISECONDS: '10001' })).rejects.toThrow(/LIVE_POLL_MILLISECONDS/);
    expect(await resolve({ LIVE_POLL_MILLISECONDS: '50' })).toMatchObject({ pollMs: 50 });
  });

  it.each([
    ['LIVE_REDIS_CONNECTION', 'LIVE_CONNECTION', 'live'],
    ['LIVE_HEARTBEAT', 'LIVE_HEARTBEAT_SECONDS', '5'],
    ['LIVE_RETRY', 'LIVE_RETRY_MILLISECONDS', '500'],
  ])('stops the start when %s is set, naming %s, instead of falling back to the default', async (from, to, value) => {
    const error = await resolve({ [from]: value }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(`${from} was renamed ${to}`);
  });
});

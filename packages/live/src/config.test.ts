import { ConfigError, resolveConfig } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import { LiveConfig } from './config.ts';

const resolve = async (env: Record<string, string>) => (await resolveConfig([LiveConfig], env)).get(LiveConfig) as LiveConfig;

describe('LiveConfig: variable names', () => {
  it('keeps the defaults under the new names', async () => {
    expect(await resolve({})).toMatchObject({ driver: 'memory', connection: 'default', pollMs: 500, heartbeatSeconds: 20, retryMs: 3000 });
  });

  it('reads the connection, the heartbeat in seconds and the retry in milliseconds by their new names', async () => {
    expect(await resolve({ LIVE_CONNECTION: 'live', LIVE_HEARTBEAT_SECONDS: '5', LIVE_RETRY_MILLISECONDS: '500' })).toMatchObject({ connection: 'live', heartbeatSeconds: 5, retryMs: 500 });
  });

  it('keeps the bounds of the heartbeat and the retry', async () => {
    await expect(resolve({ LIVE_HEARTBEAT_SECONDS: '301' })).rejects.toThrow(/LIVE_HEARTBEAT_SECONDS/);
    await expect(resolve({ LIVE_RETRY_MILLISECONDS: '99' })).rejects.toThrow(/LIVE_RETRY_MILLISECONDS/);
  });

  it('takes the database driver, its connection and its poll interval', async () => {
    expect(await resolve({ LIVE_DRIVER: 'database', LIVE_CONNECTION: 'system', LIVE_POLL_MILLISECONDS: '250' })).toMatchObject({ driver: 'database', connection: 'system', pollMs: 250 });
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

describe('LiveConfig: the deprecated redisConnection', () => {
  /** The deprecation warnings Node emitted while `read` ran. */
  async function warningsOf(read: () => void): Promise<string[]> {
    const seen: string[] = [];
    const listener = (warning: Error & { code?: string }) => void (warning.name === 'DeprecationWarning' && seen.push(`${warning.code}: ${warning.message}`));
    process.on('warning', listener);
    try {
      read();
      await new Promise((done) => setImmediate(done));
    } finally {
      process.off('warning', listener);
    }
    return seen;
  }

  it('warns nowhere in production, and reading it there does not use up the warning', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const config = await resolve({ LIVE_CONNECTION: 'live' });
      expect(await warningsOf(() => expect(config.redisConnection).toBe('live'))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reading connection never warns', async () => {
    const config = await resolve({});
    expect(await warningsOf(() => expect(config.connection).toBe('default'))).toEqual([]);
  });

  it('warns once per process when redisConnection is read in a test or development, naming connection', async () => {
    const config = await resolve({ LIVE_CONNECTION: 'live' });
    const warnings = await warningsOf(() => {
      expect(config.redisConnection).toBe('live');
      expect(config.redisConnection).toBe('live');
    });
    expect(warnings).toEqual(['live.redis-connection: [marmeon] LiveConfig.redisConnection is deprecated, use LiveConfig.connection instead. It is removed in 2.0.']);
  });

  it('is not read by copying the config — only an app that names it warns', async () => {
    const config = await resolve({});
    expect(await warningsOf(() => void { ...config })).toEqual([]);
    expect(Object.keys(config)).not.toContain('redisConnection');
  });

  it('stays assignable: a later read returns the assigned value, and connection is unaffected', async () => {
    const config = await resolve({ LIVE_CONNECTION: 'live' });
    (config as { redisConnection: string }).redisConnection = 'mine';
    expect(config.redisConnection).toBe('mine');
    expect(config.connection).toBe('live');
    expect(Object.keys(config)).not.toContain('redisConnection');
  });
});

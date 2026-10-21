import { ConfigError, createApplication, defineModule, resolveConfig } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { ServerConfig, ServerServiceProvider } from './provider.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const resolve = async (env: Record<string, string>) => (await resolveConfig([ServerConfig], env)).get(ServerConfig) as ServerConfig;

describe('ServerConfig: variable names', () => {
  it('keeps the defaults under the new names', async () => {
    expect(await resolve({})).toMatchObject({
      maxBodySize: 8 * 1024 * 1024,
      trustedProxies: [],
      ssr: true,
      health: '/up',
      shutdownDelayMs: 0,
      keepAliveTimeoutMs: 65_000,
    });
  });

  it('reads the server variables by their new names, the durations as seconds', async () => {
    expect(
      await resolve({
        SERVER_MAX_BODY_SIZE: '512k',
        SERVER_TRUSTED_PROXIES: '10.0.0.0/8',
        SERVER_ASSET_VERSION: 'abc',
        SERVER_SSR_ENABLED: 'false',
        SERVER_HEALTH_PATH: '/healthz',
        SERVER_SHUTDOWN_DELAY_SECONDS: '2.5',
        SERVER_KEEP_ALIVE_TIMEOUT_SECONDS: '30',
      }),
    ).toMatchObject({ maxBodySize: 512 * 1024, trustedProxies: ['10.0.0.0/8'], assetVersion: 'abc', ssr: false, health: '/healthz', shutdownDelayMs: 2500, keepAliveTimeoutMs: 30_000 });
  });

  it('reads the server-rendering switch with env.boolean(): 0 turns it off, anything else is an error', async () => {
    expect((await resolve({ SERVER_SSR_ENABLED: '0' })).ssr).toBe(false);
    expect((await resolve({ SERVER_SSR_ENABLED: 'FALSE' })).ssr).toBe(false);
    expect((await resolve({ SERVER_SSR_ENABLED: '1' })).ssr).toBe(true);
    await expect(resolve({ SERVER_SSR_ENABLED: 'off' })).rejects.toThrow(/SERVER_SSR_ENABLED/);
  });

  it.each([
    ['MAX_BODY_SIZE', 'SERVER_MAX_BODY_SIZE', '1m'],
    ['HEALTH_PATH', 'SERVER_HEALTH_PATH', '/healthz'],
    ['ASSET_VERSION', 'SERVER_ASSET_VERSION', 'abc'],
    ['SHUTDOWN_DELAY', 'SERVER_SHUTDOWN_DELAY_SECONDS', '5'],
    ['KEEP_ALIVE_TIMEOUT', 'SERVER_KEEP_ALIVE_TIMEOUT_SECONDS', '70'],
    ['TRUSTED_PROXIES', 'SERVER_TRUSTED_PROXIES', '10.0.0.0/8'],
    ['SSR_ENABLED', 'SERVER_SSR_ENABLED', 'false'],
  ])('stops the start when %s is set, naming %s, instead of falling back to the default', async (from, to, value) => {
    const error = await resolve({ [from]: value }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(`${from} was renamed ${to}`);
  });
});

// Which header sets the client's address decides rate limits and logs: the trusted proxies are an allow-list, and without
// the variable there are none.
describe('SERVER_TRUSTED_PROXIES: the client address end to end', () => {
  const boot = async (env: Record<string, string>) =>
    createHttpKernel(
      await createApplication(
        {
          root: import.meta.dirname,
          discover: false,
          providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
          modules: [defineModule({ name: 'whoami', routes: openRoutes((Route) => Route.get('/whoami', (ctx) => ({ ip: ctx.ip }))) })],
        },
        { env: { APP_KEY: generateKey(), ...env } },
      ),
    );
  const ipOf = async (kernel: Awaited<ReturnType<typeof boot>>, peer: string) =>
    ((await (await kernel.request('/whoami', { headers: { accept: 'application/json', 'x-forwarded-for': '198.51.100.7' } }, { remoteAddress: peer })).json()) as { ip: string }).ip;

  it('evaluates X-Forwarded-For from a peer in SERVER_TRUSTED_PROXIES only', async () => {
    const kernel = await boot({ SERVER_TRUSTED_PROXIES: '10.0.0.0/8' });
    expect(await ipOf(kernel, '10.1.2.3')).toBe('198.51.100.7');
    expect(await ipOf(kernel, '203.0.113.9')).toBe('203.0.113.9');
  });

  it('ignores X-Forwarded-For without the variable, from any peer', async () => {
    const kernel = await boot({});
    expect(await ipOf(kernel, '10.1.2.3')).toBe('10.1.2.3');
  });

  it('does not start with the old name: TRUSTED_PROXIES is never silently "no proxy"', async () => {
    await expect(boot({ TRUSTED_PROXIES: '10.0.0.0/8' })).rejects.toThrow('TRUSTED_PROXIES was renamed SERVER_TRUSTED_PROXIES');
    await expect(boot({ TRUSTED_PROXIES: '10.0.0.0/8', SERVER_TRUSTED_PROXIES: '10.0.0.0/8' })).rejects.toThrow('TRUSTED_PROXIES was renamed SERVER_TRUSTED_PROXIES');
  });
});

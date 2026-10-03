import { createApplication, HealthChecks } from '@bespokecore/core';
import { describe, expect, it } from 'vitest';
import { Cache } from './cache.ts';
import { CacheServiceProvider } from './index.ts';

describe('the cache health check (E126)', () => {
  it('adds a key and forgets it again — through the store of CACHE_DRIVER', async () => {
    await using app = await createApplication({ root: import.meta.dirname, discover: false, env: { CACHE_DRIVER: 'memory' }, providers: [CacheServiceProvider] });
    const report = await app.container.make(HealthChecks).run(app.container);
    expect(report).toMatchObject({ ok: true, checks: [{ name: 'cache', status: 'ok', note: 'memory' }] });
  });

  it('fails when the store does not take the key', async () => {
    await using app = await createApplication({
      root: import.meta.dirname,
      discover: false,
      env: { CACHE_DRIVER: 'memory' },
      providers: [CacheServiceProvider],
      override: (container) => container.instance(Cache, { add: async () => Promise.reject(new Error('the cache table is gone')), forget: async () => {} } as unknown as Cache),
    });
    const report = await app.container.make(HealthChecks).run(app.container);
    expect(report.checks[0]).toMatchObject({ name: 'cache', status: 'failing' });
    expect((report.checks[0]!.error as Error).message).toBe('the cache table is gone');
  });
});

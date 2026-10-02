import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, defineModule, type ServiceProviderClass } from '@bespokecore/core';
import { Connections, DatabaseServiceProvider } from '@bespokecore/database';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { defineRoutes, HttpServiceProvider } from '@bespokecore/http';
import { RedisServiceProvider } from '@bespokecore/redis';
import { createHttpKernel } from '@bespokecore/server';
import { afterAll, describe, expect, it } from 'vitest';
import { Cache, StoreCache } from './cache.ts';
import { MakeCacheTableCommand } from './commands/make-cache-table.ts';
import { CacheServiceProvider } from './index.ts';
import { Limit, RateLimiter, throttle } from './rate-limiter.ts';
import { DatabaseStore } from './stores/database.ts';
import { RedisStore } from './stores/redis.ts';
import { migrate, REDIS_URL } from './__fixtures__/stores.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

class Limits {
  boot(app: { container: { make(key: typeof RateLimiter): RateLimiter } }) {
    app.container.make(RateLimiter).for('login', () => Limit.perMinute(3).by('everyone'));
  }
}

function boot(env: Record<string, string>, providers: ServiceProviderClass[]) {
  return createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ...providers, CacheServiceProvider, Limits],
    modules: [defineModule({ name: 'limits', apiRoutes: defineRoutes((Route) => Route.middleware(throttle('login')).post('/login', () => ({ ok: true }))) })],
  });
}

async function statuses(app: Awaited<ReturnType<typeof boot>>, count: number): Promise<number[]> {
  const kernel = createHttpKernel(app);
  return Promise.all(Array.from({ length: count }, async () => (await kernel.request('/api/login', { method: 'POST' })).status));
}

describe('CACHE_DRIVER', () => {
  it('database: the cache and the throttle run on the app database', async () => {
    const app = await boot({ CACHE_DRIVER: 'database', DB_DATABASE: ':memory:' }, [DatabaseServiceProvider]);
    await migrate(app.container.make(Connections));
    const cache = app.container.make(Cache);
    expect(cache).toBeInstanceOf(StoreCache);
    expect((await statuses(app, 10)).sort()).toEqual([200, 200, 200, 429, 429, 429, 429, 429, 429, 429]);
    const { rows } = await import('@bespokecore/database').then(({ sql }) => sql<{ key: string; value: string }>`select key, value from cache`.execute(app.container.make(Connections).get()));
    expect(rows).toEqual([{ key: 'limiter:login:60:everyone', value: '10' }]);
    await app.shutdown();
  });

  it('database: names what is missing at startup', async () => {
    await expect(boot({ CACHE_DRIVER: 'database' }, [])).rejects.toThrow(
      'CACHE_DRIVER=database needs the DatabaseServiceProvider of @bespokecore/database (installed packages register it: bespoke discover).',
    );
    await expect(boot({ CACHE_DRIVER: 'database', CACHE_CONNECTION: 'reporting', DB_DATABASE: ':memory:' }, [DatabaseServiceProvider])).rejects.toThrow(
      /Database connection "reporting" is not configured/,
    );
  });

  it('redis: names what is missing at startup', async () => {
    await expect(boot({ CACHE_DRIVER: 'redis' }, [])).rejects.toThrow(
      'CACHE_DRIVER=redis needs the RedisServiceProvider of @bespokecore/redis (installed packages register it: bespoke discover).',
    );
  });

  it.runIf(REDIS_URL)('redis: the cache and the throttle run on Redis', async () => {
    const prefix = `bespoke-test-${crypto.randomUUID().slice(0, 8)}:`;
    const app = await boot({ CACHE_DRIVER: 'redis', REDIS_URL: REDIS_URL!, REDIS_PREFIX: prefix }, [RedisServiceProvider]);
    expect((await statuses(app, 10)).sort()).toEqual([200, 200, 200, 429, 429, 429, 429, 429, 429, 429]);
    const { RedisConnections } = await import('@bespokecore/redis');
    const redis = app.container.make(RedisConnections).get();
    expect(await redis.command(['GET', `${prefix}cache:limiter:login:60:everyone`])).toBe('10');
    await redis.command(['DEL', `${prefix}cache:limiter:login:60:everyone`]);
    await app.shutdown();
  });

  it('memory and file stay the defaults without any other package', async () => {
    const app = await boot({ CACHE_DRIVER: 'memory' }, []);
    expect((await statuses(app, 4)).sort()).toEqual([200, 200, 200, 429]);
    await app.shutdown();
  });

  it('exports the stores for apps that build their own cache', () => {
    expect(new DatabaseStore(async () => ({ db: undefined as never, driver: 'sqlite' }))).toBeDefined();
    expect(new RedisStore(async () => undefined as never)).toBeDefined();
  });
});

describe('make:cache-table', () => {
  function app(): string {
    const root = mkdtempSync(join(tmpdir(), 'bespoke-cache-table-'));
    temporary.push(root);
    mkdirSync(join(root, 'bootstrap'));
    writeFileSync(
      join(root, 'bootstrap/app.ts'),
      "import { defineApplication } from '@bespokecore/core';\nimport auth from '#modules/auth';\n\nexport default defineApplication({ root: '', modules: [auth] });\n",
    );
    return root;
  }

  function input(root: string, options: Record<string, unknown> = {}) {
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
    return { input: { root, args: [], options, output, spawn: async () => 0 } as never, lines };
  }

  it('writes the migration into the system module (E96), creating and registering the module', async () => {
    const root = app();
    const { input: first, lines } = input(root);
    expect(await new MakeCacheTableCommand().handle(first)).toBe(0);
    const [migration] = readdirSync(join(root, 'modules/system/migrations'));
    expect(migration).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}_create_cache_table\.ts$/);
    expect(readFileSync(join(root, 'modules/system/migrations', migration!), 'utf8')).toContain("schema.create('cache_locks'");
    expect(readFileSync(join(root, 'modules/system/index.ts'), 'utf8')).toContain("migrations: new URL('./migrations/', import.meta.url)");
    const bootstrap = readFileSync(join(root, 'bootstrap/app.ts'), 'utf8');
    expect(bootstrap).toContain("import system from '#modules/system';");
    expect(bootstrap).toContain('modules: [auth, system]');
    expect(lines).toEqual([
      '✓ Created modules/system/index.ts',
      `✓ Created modules/system/migrations/${migration}`,
      '✓ Registered the module in bootstrap/app.ts',
      'Then: bespoke migrate',
    ]);

    const { input: again, lines: refused } = input(root, { module: 'billing' });
    expect(await new MakeCacheTableCommand().handle(again)).toBe(1);
    expect(refused).toEqual([`✗ modules/system/migrations/${migration} already exists — the cache table has its migration.`]);
  });

  it('writes into another existing module with --module', async () => {
    const root = app();
    mkdirSync(join(root, 'modules/platform'), { recursive: true });
    writeFileSync(join(root, 'modules/platform/index.ts'), "export default defineModule({ name: 'platform', migrations: new URL('./migrations/', import.meta.url) });");
    const { input: run, lines } = input(root, { module: 'platform' });
    expect(await new MakeCacheTableCommand().handle(run)).toBe(0);
    expect(readdirSync(join(root, 'modules/platform/migrations'))).toHaveLength(1);
    expect(lines.some((line) => line.includes('Registered'))).toBe(false); // it was registered already
  });
});

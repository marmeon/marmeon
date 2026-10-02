import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, defineModule, type ConfigDefinition, type ServiceProviderClass } from '@bespokecore/core';
import { Connections, DatabaseServiceProvider, defineConnection, InfrastructureTransactionError, sql } from '@bespokecore/database';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { defineRoutes, HttpServiceProvider } from '@bespokecore/http';
import { RedisServiceProvider } from '@bespokecore/redis';
import { createHttpKernel } from '@bespokecore/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Cache, StoreCache } from './cache.ts';
import { MakeCacheTableCommand } from './commands/make-cache-table.ts';
import { CacheConfig, cacheTablesConnection, CacheServiceProvider } from './index.ts';
import { Limit, RateLimiter, throttle } from './rate-limiter.ts';
import { DatabaseStore } from './stores/database.ts';
import { RedisStore } from './stores/redis.ts';
import { freshTarget, migrate, PGSQL_URL, REDIS_URL } from './__fixtures__/stores.ts';
import * as v from 'valibot';

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

class Limits {
  boot(app: { container: { make(key: typeof RateLimiter): RateLimiter } }) {
    app.container.make(RateLimiter).for('login', () => Limit.perMinute(3).by('everyone'));
  }
}

function boot(env: Record<string, string>, providers: ServiceProviderClass[], config: ConfigDefinition<unknown>[] = []) {
  return createApplication({
    root: import.meta.dirname,
    discover: false,
    config,
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

describe('CACHE_DRIVER=database never joins the app’s transactions (E108)', () => {
  class Rollback extends Error {}
  /** A connection with a SQLite file of its own for the cache (as the web app's `system`). */
  const System = (file: string) => defineConnection('system', { env: v.object({}), resolve: () => ({ driver: 'sqlite', database: file }) });
  const counted = async (connections: Connections, name = 'default') =>
    (await sql<{ value: string }>`select value from cache where key = 'limiter:login'`.execute(connections.get(name))).rows.map((row) => row.value);

  it('SQLite without a file of its own: rate limits and locks refuse loudly inside a transaction — never a silent join', async () => {
    const app = await boot({ CACHE_DRIVER: 'database', DB_DATABASE: ':memory:' }, [DatabaseServiceProvider]);
    const connections = app.container.make(Connections);
    await migrate(connections);
    const limiter = app.container.make(RateLimiter);
    const cache = app.container.make(Cache);
    await expect(
      connections.transaction(async () => {
        await expect(limiter.hit('login', 60)).rejects.toThrow(InfrastructureTransactionError);
        await expect(limiter.hit('login', 60)).rejects.toThrow(
          'The cache (CACHE_DRIVER=database — also rate limits and locks) cannot work inside the open transaction on the database connection "default" (E108): it is a SQLite file',
        );
        await expect(limiter.hit('login', 60)).rejects.toThrow(
          "Give the cache its own SQLite file — a connection like defineConnection('system', …) for storage/system.sqlite, CACHE_CONNECTION=system, and `bespoke migrate` (the migration of `bespoke make:cache-table` follows CACHE_CONNECTION) — or use Redis (CACHE_DRIVER=redis).",
        );
        await expect(cache.lock('stats:7', 60).get()).rejects.toThrow(InfrastructureTransactionError);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    // Outside of transactions — the normal case — the shared file works.
    expect(await limiter.hit('login', 60)).toBe(1);
    await app.shutdown();
  });

  it('SQLite with a file of its own (CACHE_CONNECTION): works inside a transaction, and a hit survives its rollback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bespoke-cache-system-'));
    temporary.push(directory);
    const app = await boot(
      { CACHE_DRIVER: 'database', CACHE_CONNECTION: 'system', DB_DATABASE: join(directory, 'app.sqlite') },
      [DatabaseServiceProvider],
      [System(join(directory, 'system.sqlite'))],
    );
    const connections = app.container.make(Connections);
    await migrate(connections, 'system');
    const limiter = app.container.make(RateLimiter);
    await expect(
      connections.transaction(async () => {
        expect(await limiter.hit('login', 60)).toBe(1);
        expect(await limiter.hit('login', 60)).toBe(2);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await counted(connections, 'system')).toEqual(['2']);
    await app.shutdown();
  });

  it('puts the cache tables where the cache looks: CACHE_CONNECTION with the database driver, else default', async () => {
    const tablesOn = async (env: Record<string, string>) => {
      const app = await boot({ DB_DATABASE: ':memory:', ...env }, [DatabaseServiceProvider], [System(':memory:')]);
      const name = cacheTablesConnection(app.container);
      expect(app.container.make(CacheConfig).driver).toBe(env.CACHE_DRIVER ?? 'file');
      await app.shutdown();
      return name;
    };
    expect(await tablesOn({ CACHE_DRIVER: 'database', CACHE_CONNECTION: 'system' })).toBe('system');
    expect(await tablesOn({ CACHE_DRIVER: 'database' })).toBe('default');
    expect(await tablesOn({ CACHE_DRIVER: 'memory', CACHE_CONNECTION: 'system' })).toBe('default');
  });

  describe.runIf(PGSQL_URL)('on Postgres: a pool of its own, nothing to configure', () => {
    let url: string;
    let drop: () => Promise<void>;
    beforeAll(async () => {
      const fresh = await freshTarget('pgsql');
      url = (fresh.target as { url: string }).url;
      drop = fresh.drop;
    });
    afterAll(() => drop());
    const pgsql = () => boot({ CACHE_DRIVER: 'database', DB_CONNECTION: 'pgsql', DB_URL: url }, [DatabaseServiceProvider]);

    it('a rate-limit hit inside a transaction that rolls back is kept', async () => {
      const app = await pgsql();
      const connections = app.container.make(Connections);
      await sql`delete from cache`.execute(connections.get());
      const limiter = app.container.make(RateLimiter);
      await expect(
        connections.transaction(async () => {
          await limiter.hit('login', 60);
          await limiter.hit('login', 60);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(await counted(connections)).toEqual(['2']);
      await app.shutdown();
    });

    it('a lock taken inside an open transaction is visible to another process at once', async () => {
      const [app, other] = [await pgsql(), await pgsql()];
      const lock = app.container.make(Cache).lock('unique:stats:7', 60);
      await app.container.make(Connections).transaction(async () => {
        expect(await lock.get()).toBe(true);
        // Still inside the transaction: the other process sees the lock and does not get it.
        expect(await other.container.make(Cache).lock('unique:stats:7', 60).get()).toBe(false);
        await lock.release();
      });
      await Promise.all([app.shutdown(), other.shutdown()]);
    });
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

import { isAbsolute, join } from 'node:path';
import type { ProviderMigrations } from '@marmeon/database';
import { Application, Clock, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import { collectDrivers } from '@marmeon/core/internal';
import { GLOBAL, MiddlewarePriority, Router } from '@marmeon/router';
import { Cache, StoreCache, type CacheDriver, type CacheDriverFactory, type CacheStore, type LockStore } from './cache.ts';
import { CacheConfig } from './config.ts';
import { CacheSetupError } from './errors.ts';
import { CacheHealthCheck } from './health.ts';
import { guardDriver, verifyDriver } from './guarded.ts';
import { MakeCacheTableCommand } from './commands/make-cache-table.ts';
import { CacheClearCommand, CachePruneCommand } from './commands/prune.ts';
import { LimitLiveValidation, RateLimiter } from './rate-limiter.ts';
import { CACHE_COLUMNS, CACHE_LOCKS_COLUMNS, CACHE_LOCKS_TABLE, CACHE_TABLE, DatabaseStore } from './stores/database.ts';
import { FileStore } from './stores/file.ts';
import { MemoryStore } from './stores/memory.ts';
import { RedisStore } from './stores/redis.ts';
import { withCode } from '@marmeon/core/internal';
import type { CommandClass } from 'marmeon';

export { Cache, Lock } from './cache.ts';
export type { CacheDriver, CacheDriverContext, CacheDriverFactory, CacheEntry, CacheStore, LockStore } from './cache.ts';
export { clientKey, Limit, LimitLiveValidation, RateLimiter, throttle } from './rate-limiter.ts';
export type { LimiterCallback, LimiterContext } from './rate-limiter.ts';

export { CacheConfig } from './config.ts';
export { CacheHealthCheck } from './health.ts';

export { CacheSetupError } from './errors.ts';

declare module '@marmeon/core' {
  interface ServiceProviderClass {
    /**
     * Cache drivers this provider brings, by name — `CACHE_DRIVER=<name>` selects one. A built-in name (`file`, `memory`, `database`,
     * `redis`) or a name another provider brings stops the start. See `docs/drivers.md#cache-drivers`.
     */
    readonly cacheDrivers?: Readonly<Record<string, CacheDriverFactory>>;
  }
}

/** The names the framework's own drivers answer to — a provider cannot bring a driver under one of them. */
const BUILT_IN_CACHE_DRIVERS = ['file', 'memory', 'database', 'redis'] as const;

async function importOptional<T>(load: () => Promise<T>, name: string, driver: string, install: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if (code === 'ERR_MODULE_NOT_FOUND' && typeof message === 'string' && message.includes(name)) {
      throw new CacheSetupError(withCode('S1', `CACHE_DRIVER=${driver} needs ${name}, which is not installed in this app: ${install}`));
    }
    throw error;
  }
}

/** For messages of the database: who uses its infrastructure connection, and what to do on a shared SQLite file. */
const CACHE_INFRASTRUCTURE = {
  system: 'The cache (CACHE_DRIVER=database — also rate limits and locks)',
  remedy:
    "Give the cache its own SQLite file — a connection like defineConnection('system', …) for storage/system.sqlite, CACHE_CONNECTION=system, " +
    'and `marmeon migrate` (the migration of `marmeon make:cache-table` follows CACHE_CONNECTION) — or use Redis (CACHE_DRIVER=redis).',
};

/**
 * The connection the cache's tables belong on — for the migration `marmeon make:cache-table` writes (`connection` in
 * `defineMigration`): `CACHE_CONNECTION` with the database driver, else `default`.
 */
export function cacheTablesConnection(container: Resolver): string {
  const config = container.make(CacheConfig);
  return config.driver === 'database' ? config.connection : 'default';
}

const importDatabase = () => importOptional(() => import('@marmeon/database'), '@marmeon/database', 'database', 'pnpm add -E @marmeon/database@<version of your app>');
const importRedis = () => importOptional(() => import('@marmeon/redis'), '@marmeon/redis', 'redis', 'pnpm add -E @marmeon/redis@<version of your app>');

/** Registers the `Cache` (`CACHE_DRIVER`) and the `RateLimiter`, and `make:cache-table`. Found by `marmeon discover`. */
export class CacheServiceProvider implements ServiceProvider {
  static config = [CacheConfig];
  /** The cache takes and frees a key, for `/up/ready`. */
  static health = [CacheHealthCheck];
  static commands: readonly CommandClass[] = [MakeCacheTableCommand, CachePruneCommand, CacheClearCommand];
  /** The migrations for the cache table, which `marmeon publish` and the `make:*-table` command copy into the app. */
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: 'system' } satisfies ProviderMigrations;

  /** The driver a provider brought under `CACHE_DRIVER`, built once; a factory that failed is not run again. */
  #custom: CacheDriver | undefined;
  #failure: unknown;

  register(container: Container): void {
    const config = container.make(CacheConfig);
    container.singleton(Cache, (c) => new StoreCache(this.#driver(config, c), config.prefix, c.make(Clock)));
    container.singleton(RateLimiter);
  }

  #factories(container: Resolver): ReadonlyMap<string, CacheDriverFactory> {
    return collectDrivers<CacheDriverFactory>(container.make(Application).providers, 'cacheDrivers', BUILT_IN_CACHE_DRIVERS, 'cache driver');
  }

  /** The driver `CACHE_DRIVER` names: a built-in one, or what a provider's factory returns — checked, and wrapped so that it sees only valid keys and owners. */
  #driver(config: CacheConfig, container: Resolver): CacheDriver {
    const factory = this.#factories(container).get(config.driver);
    if (!factory) return builtIn(config, container);
    if (this.#custom) return this.#custom;
    if (this.#failure !== undefined) throw this.#failure;
    try {
      const clock = container.make(Clock);
      this.#custom = guardDriver(config.driver, factory({ name: config.driver, container, clock, prefix: config.prefix }), clock);
      return this.#custom;
    } catch (error) {
      this.#failure = error;
      throw error;
    }
  }

  async boot(app: Application): Promise<void> {
    // Live validations are limited on every route — in the global stack, before anything else runs for them.
    if (app.container.has(Router)) app.container.make(Router).middleware.append(GLOBAL, LimitLiveValidation, MiddlewarePriority.limitLiveValidation);

    // A driver whose package is missing fails the start with what to install — not the first request with a stack trace.
    const config = app.container.make(CacheConfig);
    const { driver, connection } = config;
    // A built-in name, a name twice or a malformed one stops the start here; so does a CACHE_DRIVER nobody brought.
    const custom = this.#factories(app.container);
    if (!(BUILT_IN_CACHE_DRIVERS as readonly string[]).includes(driver) && !custom.has(driver)) {
      throw new CacheSetupError(withCode('S1', `CACHE_DRIVER=${driver} is not a cache driver. Known: ${[...BUILT_IN_CACHE_DRIVERS, ...custom.keys()].join(', ')}.`));
    }
    if (custom.has(driver)) {
      // Built and tried now: a factory's error, or a lock store that does not exclude, stops the start — not the first job.
      await verifyDriver(driver, this.#driver(config, app.container), app.container.make(Clock), config.prefix);
    } else if (driver === 'redis') {
      const redis = await importRedis();
      if (!app.container.has(redis.RedisConnections)) {
        throw new CacheSetupError(withCode('S1', 'CACHE_DRIVER=redis needs the RedisServiceProvider of @marmeon/redis (installed packages register it: marmeon discover).'));
      }
      const connections = app.container.make(redis.RedisConnections);
      connections.options(connection);
      await connections.verify();
    } else if (driver === 'database') {
      const database = await importDatabase();
      if (!app.container.has(database.Connections)) {
        throw new CacheSetupError(withCode('S1', 'CACHE_DRIVER=database needs the DatabaseServiceProvider of @marmeon/database (installed packages register it: marmeon discover).'));
      }
      app.container.make(database.Connections).options(connection);
      // /up/ready is red until the tables have the new names and every column the store writes.
      const { SchemaRequirements } = await import('@marmeon/database');
      const requirements = app.container.make(SchemaRequirements);
      requirements.require({ connection, table: CACHE_TABLE, columns: CACHE_COLUMNS });
      requirements.require({ connection, table: CACHE_LOCKS_TABLE, columns: CACHE_LOCKS_COLUMNS });
    }
  }
}

/** The driver of `CACHE_DRIVER`. Database and Redis connections are looked up on first use, through their packages. */
function builtIn(config: CacheConfig, container: Resolver): CacheDriver {
  const clock = container.make(Clock);
  const both = (store: CacheStore & LockStore): CacheDriver => ({ store, locks: store });
  switch (config.driver) {
    case 'memory':
      return both(new MemoryStore(clock));
    case 'database':
      return both(
        new DatabaseStore(async () => {
          const { Connections } = await importDatabase();
          const connections = container.make(Connections);
          // Its own connection, never the app's transaction: a rate-limit hit or a lock survives a rollback.
          return { db: connections.infrastructure(config.connection, CACHE_INFRASTRUCTURE), driver: connections.options(config.connection).driver };
        }, clock),
      );
    case 'redis':
      return both(new RedisStore(async () => container.make((await importRedis()).RedisConnections).get(config.connection), clock));
    case 'file': {
      const { root } = container.make(Application);
      return both(new FileStore(isAbsolute(config.path) ? config.path : join(root, config.path), clock));
    }
    default:
      throw new CacheSetupError(withCode('S1', `CACHE_DRIVER=${config.driver} is not a cache driver. Known: ${BUILT_IN_CACHE_DRIVERS.join(', ')}.`));
  }
}

import { isAbsolute, join } from 'node:path';
import { Application, Clock, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import { GLOBAL, MiddlewarePriority, Router } from '@marmeon/router';
import { Cache, StoreCache, type CacheStore } from './cache.ts';
import { CacheConfig } from './config.ts';
import { CacheHealthCheck } from './health.ts';
import { MakeCacheTableCommand } from './commands/make-cache-table.ts';
import { CacheClearCommand, CachePruneCommand } from './commands/prune.ts';
import { LimitLiveValidation, RateLimiter } from './rate-limiter.ts';
import { DatabaseStore } from './stores/database.ts';
import { FileStore } from './stores/file.ts';
import { MemoryStore } from './stores/memory.ts';
import { RedisStore } from './stores/redis.ts';

export { Cache, Lock, LockTimeoutError, StoreCache } from './cache.ts';
export type { CacheStore, Entry } from './cache.ts';
export { CACHE_LOCKS_TABLE, CACHE_TABLE, DatabaseStore } from './stores/database.ts';
export type { DatabaseStoreConnection } from './stores/database.ts';
export { FileStore } from './stores/file.ts';
export { MemoryStore } from './stores/memory.ts';
export { RedisStore } from './stores/redis.ts';
export type { RedisStoreConnection } from './stores/redis.ts';
export { CACHE_MIGRATION, MakeCacheTableCommand } from './commands/make-cache-table.ts';
export { CacheClearCommand, CachePruneCommand } from './commands/prune.ts';
export { DEFAULT_LIVE_VALIDATION_LIMIT, Limit, LimitLiveValidation, LIVE_VALIDATION_LIMITER, RateLimiter, throttle } from './rate-limiter.ts';
export type { LimiterCallback } from './rate-limiter.ts';

export { CacheConfig } from './config.ts';
export { CacheHealthCheck } from './health.ts';

/** A driver's package is missing: what to install, said at startup (the CLI prints it without a stack trace). */
export class CacheSetupError extends Error {
  override name = 'CacheSetupError';
}

async function importOptional<T>(load: () => Promise<T>, name: string, driver: string, install: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if (code === 'ERR_MODULE_NOT_FOUND' && typeof message === 'string' && message.includes(name)) {
      throw new CacheSetupError(`CACHE_DRIVER=${driver} needs ${name}, which is not installed in this app: ${install}`);
    }
    throw error;
  }
}

/** For messages of the database: who uses its infrastructure connection, and what to do on a shared SQLite file (E108). */
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

const importDatabase = () => importOptional(() => import('@marmeon/database'), '@marmeon/database', 'database', 'pnpm add @marmeon/database');
const importRedis = () => importOptional(() => import('@marmeon/redis'), '@marmeon/redis', 'redis', 'pnpm add @marmeon/redis redis');

/** Registers the `Cache` (`CACHE_DRIVER`) and the `RateLimiter`, and `make:cache-table`. Found by `marmeon discover`. */
export class CacheServiceProvider implements ServiceProvider {
  static config = [CacheConfig];
  /** The cache takes and frees a key, for `/up/ready` (E126). */
  static health = [CacheHealthCheck];

  register(container: Container): void {
    const config = container.make(CacheConfig);
    container.singleton(Cache, (c) => new StoreCache(storeFor(config, c), config.prefix, c.make(Clock)));
    container.singleton(RateLimiter);
  }

  async boot(app: Application): Promise<void> {
    // Live validations (E62) are limited on every route — in the global stack, before anything else runs for them.
    if (app.container.has(Router)) app.container.make(Router).middleware.append(GLOBAL, LimitLiveValidation, MiddlewarePriority.limitLiveValidation);

    // A driver whose package is missing fails the start with what to install — not the first request with a stack trace.
    const { driver, connection } = app.container.make(CacheConfig);
    if (driver === 'redis') {
      const redis = await importRedis();
      if (!app.container.has(redis.RedisConnections)) {
        throw new CacheSetupError('CACHE_DRIVER=redis needs the RedisServiceProvider of @marmeon/redis (installed packages register it: marmeon discover).');
      }
      const connections = app.container.make(redis.RedisConnections);
      connections.options(connection);
      await connections.verify();
    } else if (driver === 'database') {
      const database = await importDatabase();
      if (!app.container.has(database.Connections)) {
        throw new CacheSetupError('CACHE_DRIVER=database needs the DatabaseServiceProvider of @marmeon/database (installed packages register it: marmeon discover).');
      }
      app.container.make(database.Connections).options(connection);
    }

    const cli = await import('marmeon').catch(() => undefined);
    if (cli && app.container.has(cli.CommandRegistry)) app.container.make(cli.CommandRegistry).add([MakeCacheTableCommand, CachePruneCommand, CacheClearCommand]);
  }
}

/** The store of `CACHE_DRIVER`. Database and Redis connections are looked up on first use, through their packages. */
function storeFor(config: CacheConfig, container: Resolver): CacheStore {
  const clock = container.make(Clock);
  switch (config.driver) {
    case 'memory':
      return new MemoryStore(clock);
    case 'database':
      return new DatabaseStore(async () => {
        const { Connections } = await importDatabase();
        const connections = container.make(Connections);
        // Its own connection, never the app's transaction (E108): a rate-limit hit or a lock survives a rollback.
        return { db: connections.infrastructure(config.connection, CACHE_INFRASTRUCTURE), driver: connections.options(config.connection).driver };
      }, clock);
    case 'redis':
      return new RedisStore(async () => container.make((await importRedis()).RedisConnections).get(config.connection), clock);
    case 'file': {
      const { root } = container.make(Application);
      return new FileStore(isAbsolute(config.path) ? config.path : join(root, config.path), clock);
    }
  }
}

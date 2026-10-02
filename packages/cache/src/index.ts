import { isAbsolute, join } from 'node:path';
import { Application, Clock, defineConfig, type ConfigOf, type Container, type Resolver, type ServiceProvider } from '@bespokecore/core';
import { GLOBAL, MiddlewarePriority, Router } from '@bespokecore/router';
import * as v from 'valibot';
import { Cache, StoreCache, type CacheStore } from './cache.ts';
import { MakeCacheTableCommand } from './commands/make-cache-table.ts';
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
export { MakeCacheTableCommand } from './commands/make-cache-table.ts';
export { DEFAULT_LIVE_VALIDATION_LIMIT, Limit, LimitLiveValidation, LIVE_VALIDATION_LIMITER, RateLimiter, throttle } from './rate-limiter.ts';
export type { LimiterCallback } from './rate-limiter.ts';

export const CacheConfig = defineConfig('cache', {
  env: v.object({
    /**
     * `file` (default: shared by the processes of one machine, survives restarts), `database` (the app's database —
     * `bespoke make:cache-table` writes the migration), `redis` (needs @bespokecore/redis and redis) or `memory`
     * (tests, one process).
     */
    CACHE_DRIVER: v.optional(v.picklist(['file', 'memory', 'database', 'redis']), 'file'),
    /**
     * Which database or Redis connection the `database`/`redis` driver uses. The database driver never joins the app's
     * transactions (E108): on Postgres it opens a small pool of its own; on SQLite name a connection with a file of its
     * own here, or rate limits and locks cannot be used inside a transaction.
     */
    CACHE_CONNECTION: v.optional(v.string(), 'default'),
    /** Where the `file` driver keeps entries, relative to the app root. */
    CACHE_PATH: v.optional(v.string(), 'storage/framework/cache'),
    /** Prepended to every key and lock — apps sharing a store stay apart. */
    CACHE_PREFIX: v.optional(v.string(), ''),
  }),
  resolve: (env) => ({ driver: env.CACHE_DRIVER, connection: env.CACHE_CONNECTION, path: env.CACHE_PATH, prefix: env.CACHE_PREFIX }),
});
export type CacheConfig = ConfigOf<typeof CacheConfig>;

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
    'and `bespoke migrate` (the migration of `bespoke make:cache-table` follows CACHE_CONNECTION) — or use Redis (CACHE_DRIVER=redis).',
};

/**
 * The connection the cache's tables belong on — for the migration `bespoke make:cache-table` writes (`connection` in
 * `defineMigration`): `CACHE_CONNECTION` with the database driver, else `default`.
 */
export function cacheTablesConnection(container: Resolver): string {
  const config = container.make(CacheConfig);
  return config.driver === 'database' ? config.connection : 'default';
}

const importDatabase = () => importOptional(() => import('@bespokecore/database'), '@bespokecore/database', 'database', 'pnpm add @bespokecore/database');
const importRedis = () => importOptional(() => import('@bespokecore/redis'), '@bespokecore/redis', 'redis', 'pnpm add @bespokecore/redis redis');

/** Registers the `Cache` (`CACHE_DRIVER`) and the `RateLimiter`, and `make:cache-table`. Found by `bespoke discover`. */
export class CacheServiceProvider implements ServiceProvider {
  static config = [CacheConfig];

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
        throw new CacheSetupError('CACHE_DRIVER=redis needs the RedisServiceProvider of @bespokecore/redis (installed packages register it: bespoke discover).');
      }
      const connections = app.container.make(redis.RedisConnections);
      connections.options(connection);
      await connections.verify();
    } else if (driver === 'database') {
      const database = await importDatabase();
      if (!app.container.has(database.Connections)) {
        throw new CacheSetupError('CACHE_DRIVER=database needs the DatabaseServiceProvider of @bespokecore/database (installed packages register it: bespoke discover).');
      }
      app.container.make(database.Connections).options(connection);
    }

    const cli = await import('@bespokecore/cli').catch(() => undefined);
    if (cli && app.container.has(cli.CommandRegistry)) app.container.make(cli.CommandRegistry).add([MakeCacheTableCommand]);
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

import { defineConfig, env, type ConfigOf } from '@marmeon/core';

export const CacheConfig = defineConfig('cache', {
  env: env({
    /**
     * `file` (default: shared by the processes of one machine, survives restarts), `database` (the app's database —
     * `marmeon make:cache-table` writes the migration), `redis` (needs @marmeon/redis — it brings redis) or `memory`
     * (tests, one process).
     */
    CACHE_DRIVER: env.in(['file', 'memory', 'database', 'redis']).default('file'),
    /**
     * Which database or Redis connection the `database`/`redis` driver uses. The database driver never joins the app's
     * transactions (E108): on Postgres it opens a small pool of its own; on SQLite name a connection with a file of its
     * own here, or rate limits and locks cannot be used inside a transaction.
     */
    CACHE_CONNECTION: env.string().default('default'),
    /** Where the `file` driver keeps entries, relative to the app root. */
    CACHE_PATH: env.string().default('storage/framework/cache'),
    /** Prepended to every key and lock — apps sharing a store stay apart. */
    CACHE_PREFIX: env.string().default(''),
  }),
  resolve: (e) => ({ driver: e.CACHE_DRIVER, connection: e.CACHE_CONNECTION, path: e.CACHE_PATH, prefix: e.CACHE_PREFIX }),
});
export type CacheConfig = ConfigOf<typeof CacheConfig>;

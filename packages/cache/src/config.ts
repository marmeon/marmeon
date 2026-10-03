import { defineConfig, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';

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

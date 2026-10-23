import { env } from '@marmeon/core';
import { defineConnection } from '@marmeon/database';

/**
 * The `system` connection: a SQLite file of its own for the cache (with rate limits and locks) and the sessions —
 * `CACHE_CONNECTION=system`, `SESSION_CONNECTION=system` (.env.example). They never join the app's transactions; on
 * a file of their own they also work inside one, while the app's file is locked by it. The tables are migrated there by
 * their migrations in modules/system (they follow CACHE_CONNECTION / SESSION_CONNECTION).
 *
 * With Postgres (`DB_DRIVER=pgsql`) leave CACHE_CONNECTION and SESSION_CONNECTION unset: the cache and the sessions open
 * a small pool of their own to the app's database by themselves. This connection then stays unused (it never opens).
 */
export const SystemDatabase = defineConnection('system', {
  env: env({
    /** The file, relative to the app root (`:memory:` in tests). */
    SYSTEM_DB_DATABASE: env.string().default('storage/system.sqlite'),
  }),
  resolve: (e) => ({ driver: 'sqlite', database: e.SYSTEM_DB_DATABASE }),
});

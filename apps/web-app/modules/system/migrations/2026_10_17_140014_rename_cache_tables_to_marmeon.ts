// @marmeon-stub cache 2
import { cacheTablesConnection } from '@marmeon/cache';
import { defineMigration } from '@marmeon/database';

// The cache's tables under the names the framework reserves: cache becomes marmeon_cache, cache_locks becomes
// marmeon_cache_locks, with their indexes and constraints. The entries and the locks stay. Stop every process of the old
// release — web, workers, scheduler, cron jobs — before `marmeon migrate`: one that keeps running fails on the new names.
export default defineMigration({
  connection: cacheTablesConnection,
  up: async (schema) => {
    await schema.rename('cache', 'marmeon_cache', { indexes: true });
    await schema.rename('cache_locks', 'marmeon_cache_locks', { indexes: true });
  },
  down: async (schema) => {
    await schema.rename('marmeon_cache_locks', 'cache_locks', { indexes: true });
    await schema.rename('marmeon_cache', 'cache', { indexes: true });
  },
});

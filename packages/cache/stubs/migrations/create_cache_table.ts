import { cacheTablesConnection } from '@marmeon/cache';
import { defineMigration } from '@marmeon/database';

// The tables of CACHE_DRIVER=database (written by `marmeon make:cache-table`): a row per key — the value as JSON, the
// expiry in epoch milliseconds (null: never) — and a row per lock with its owner's token. They live on the cache's
// connection (CACHE_CONNECTION) — with SQLite best a file of its own, so rate limits and locks work inside transactions.
export default defineMigration({
  connection: cacheTablesConnection,
  up: async (schema) => {
    await schema.create('cache', (table) => {
      table.text('key').primary();
      table.text('value');
      table.bigInteger('expiration').nullable();
      table.index('expiration');
    });
    await schema.create('cache_locks', (table) => {
      table.text('key').primary();
      table.string('owner');
      table.bigInteger('expiration');
    });
  },
  down: async (schema) => {
    await schema.drop('cache_locks');
    await schema.drop('cache');
  },
});

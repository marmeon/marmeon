import { defineMigration } from '@bespokecore/database';

// The tables of CACHE_DRIVER=database (written by `bespoke make:cache-table`): a row per key — the value as JSON, the
// expiry in epoch milliseconds (null: never) — and a row per lock with its owner's token.
export default defineMigration({
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

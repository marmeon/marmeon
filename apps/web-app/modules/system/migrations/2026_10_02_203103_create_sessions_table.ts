import { defineMigration } from '@bespokecore/database';

// The table of SESSION_DRIVER=database (written by `bespoke make:session-table`): a row per session — the data as JSON
// (secret: never part of a `selectAll()`, it holds the CSRF token), the signed-in user's id (null for guests) and the
// time of the last write in epoch milliseconds. Expired rows go with `bespoke session:prune` (or the lottery).
export default defineMigration({
  up: async (schema) => {
    await schema.create('sessions', (table) => {
      table.string('id', 64).primary();
      table.string('user_id').nullable();
      table.text('payload').secret();
      table.bigInteger('last_activity');
      table.index('user_id');
      table.index('last_activity');
    });
  },
  down: async (schema) => {
    await schema.drop('sessions');
  },
});

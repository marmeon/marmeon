import { defineMigration } from '@marmeon/database';
import { sessionTableConnection } from '@marmeon/session';

// The table of SESSION_DRIVER=database (written by `marmeon make:session-table`): a row per session — the data as JSON
// (secret: never part of a `selectAll()`, it holds the CSRF token), the signed-in user's id (null for guests) and the
// time of the last write in epoch milliseconds. Expired rows go with `marmeon session:prune` (or the lottery). It lives on
// the sessions' connection (SESSION_CONNECTION) — with SQLite best a file of its own (E108).
export default defineMigration({
  connection: sessionTableConnection,
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

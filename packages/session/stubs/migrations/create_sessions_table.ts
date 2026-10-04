import { defineMigration } from '@bespokecore/database';
import { sessionTableConnection } from '@bespokecore/session';

// The table of SESSION_DRIVER=database (written by `bespoke make:session-table`): a row per session — keyed by the SHA-256 of
// the session id (never the id itself, which only the cookie carries), the payload as text (JSON, or encrypted with
// SESSION_ENCRYPT; secret: never part of a `selectAll()`, it holds the CSRF token), the signed-in user's id (null for guests),
// the time of the last write in epoch milliseconds and a version every write compares and raises. Expired rows go with
// `bespoke session:prune` (or the lottery). It lives on the sessions' connection (SESSION_CONNECTION) — with SQLite best a file
// of its own (E108).
export default defineMigration({
  connection: sessionTableConnection,
  up: async (schema) => {
    await schema.create('sessions', (table) => {
      table.string('id', 64).primary();
      table.string('user_id').nullable();
      table.text('payload').secret();
      table.bigInteger('last_activity');
      table.integer('version').default(1);
      table.index('user_id');
      table.index('last_activity');
    });
  },
  down: async (schema) => {
    await schema.drop('sessions');
  },
});

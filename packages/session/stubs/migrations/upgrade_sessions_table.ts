import { defineMigration } from '@marmeon/database';
import { sessionTableConnection } from '@marmeon/session';

// Brings a sessions table made before Marmeon stored hashed session ids and compared versions up to date —
// written by `marmeon make:session-table --upgrade`. The table is made anew: its rows are keyed by raw ids, which no request
// looks up any more (and which nobody should be able to read), so every user is signed out once.
export default defineMigration({
  connection: sessionTableConnection,
  up: async (schema) => {
    await schema.dropIfExists('sessions');
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
    await schema.create('sessions', (table) => {
      table.string('id', 64).primary();
      table.string('user_id').nullable();
      table.text('payload').secret();
      table.bigInteger('last_activity');
      table.index('user_id');
      table.index('last_activity');
    });
  },
});

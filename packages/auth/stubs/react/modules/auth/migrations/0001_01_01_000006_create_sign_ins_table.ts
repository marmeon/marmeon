// @marmeon-stub sign-ins 2
import { defineMigration } from '@marmeon/database';

// The sign-ins list: a row per sign-in of a browser, and the authority over it — the session carries only the row's random id, and a
// session whose row is gone ends. A remember-me cookie hangs on the row by its selector. The user agent is cut to 255 characters; no
// IP address is stored (the `Login` event carries it, for an audit log). `last_seen_at` is written at most every five minutes.
export default defineMigration({
  up: (schema) =>
    schema.create('marmeon_sign_ins', (table) => {
      table.string('id', 22).primary();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('user_agent', 255).nullable();
      table.string('remember_selector', 32).nullable().unique();
      table.timestamp('remember_until').nullable();
      table.timestamp('signed_in_at');
      table.timestamp('last_seen_at');
      table.timestamps();
      table.index('user_id');
    }),
  down: (schema) => schema.drop('marmeon_sign_ins'),
});

// @marmeon-stub session 2
import { defineMigration } from '@marmeon/database';
import { sessionTableConnection } from '@marmeon/session';

// The sessions' table under the name the framework reserves: sessions becomes marmeon_sessions, with its indexes and
// constraints; the payload stays secret. The rows stay, but the new release does not read a session of the old one: its
// owner signs in again, and `marmeon session:prune` removes the rows once they expire. Stop every process of the old release — web,
// workers, scheduler, cron jobs — before `marmeon migrate`: one that keeps running fails on the new name.
export default defineMigration({
  connection: sessionTableConnection,
  up: async (schema) => {
    await schema.rename('sessions', 'marmeon_sessions', { indexes: true });
  },
  down: async (schema) => {
    await schema.rename('marmeon_sessions', 'sessions', { indexes: true });
  },
});

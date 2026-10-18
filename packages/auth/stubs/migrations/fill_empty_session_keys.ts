// @marmeon-stub auth 3
import { defineMigration, sql } from '@marmeon/database';

// Gives every account without a session key (`users.session_key` is NULL: accounts made before registrations and factories gave one)
// a random one from the database's own cryptographic generator: 32 random bytes as 64 hex characters on SQLite (`randomblob`), two
// random UUIDs without dashes on Postgres (`gen_random_uuid`). A NULL key cannot be locked when a factor is added, and a new password
// cannot compare it against an ending that landed meanwhile. The value is drawn for every row; none is shared. A new key changes the fingerprint, so an account that
// had none is signed out once, on every device (accounts with a key keep their sessions). It is not reversed: a random key is as good as none.
export default defineMigration({
  up: (schema) => {
    schema.data(async (db, { driver }) => {
      if (driver !== 'pgsql' && driver !== 'sqlite') throw new Error(`fill_empty_session_keys: no source of random bytes known for the "${driver}" driver`);
      const key = driver === 'pgsql' ? sql`replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')` : sql`lower(hex(randomblob(32)))`;
      await db.updateTable('users').set({ session_key: key }).where('session_key', 'is', null).execute();
    });
  },
  down: () => {},
});

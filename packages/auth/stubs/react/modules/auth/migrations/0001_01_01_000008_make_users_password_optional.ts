import { defineMigration, sql } from '@marmeon/database';

// `users.password` may hold NULL: an account without a password signs in by no password at all and gets one through a reset link.
// SQLite changes no column in place (`nullable()` in an `alter()` is refused there, error D18), so the column is made again: a nullable
// one is added, takes the stored hashes, and replaces the old one under its name. The new column is `.secret()` as the old one was, and
// the rename carries the mark: `Row<'users'>` and select-all results still never hold a hash. Not reversed: a NOT NULL column cannot take
// the accounts that have no password.
export default defineMigration({
  up: (schema) => {
    schema.alter('users', (table) => {
      table.string('password_optional').nullable().secret();
    });
    schema.data(async (db) => {
      await db.updateTable('users').set({ password_optional: sql`password` }).execute();
    });
    schema.alter('users', (table) => {
      table.dropColumn('password');
    });
    schema.alter('users', (table) => {
      table.renameColumn('password_optional', 'password');
    });
  },
  down: () => {},
});

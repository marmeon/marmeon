import { defineMigration } from '@marmeon/database';

// A pending change of address lives in the table `email_changes` now, not in three columns of `users` that every module reads. A change
// that is open is not carried over: the first kit did not drop it when the password changed or was reset, so a carried-over change would
// outlive such a change of password. Whoever has one open asks for it again after the upgrade. The three columns go; `down` puts them back empty.
export default defineMigration({
  up: (schema) => {
    schema.create('email_changes', (table) => {
      table.foreignId('user_id').constrained().cascadeOnDelete().primary();
      table.string('email', 255);
      table.string('token_hash', 64).secret();
      // The session key of the account when the change was asked for; the link works only while the account still holds it.
      table.string('session_key', 64).nullable().secret();
      table.timestamp('expires_at');
      table.timestamp('created_at');
    });
    schema.alter('users', (table) => {
      table.dropColumn('pending_email');
      table.dropColumn('pending_email_token');
      table.dropColumn('pending_email_expires_at');
    });
  },
  down: (schema) => {
    schema.alter('users', (table) => {
      table.string('pending_email', 255).nullable();
      table.string('pending_email_token', 64).nullable().secret();
      table.timestamp('pending_email_expires_at').nullable();
    });
    schema.drop('email_changes');
  },
});

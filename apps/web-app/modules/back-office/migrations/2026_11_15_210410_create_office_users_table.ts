import { defineMigration } from '@marmeon/database';

// The back office's editors: a table of their own, apart from the app's `users`. The password hash and the session key are secret
// columns, so no select-all result carries them. `role` is `editor` or `viewer`, and the least one is the default: the mode that serves
// the package's own editors reads it, and a text that is neither opens nothing. The mode that serves the app's users reads no row.
export default defineMigration({
  up: (schema) =>
    schema.create('office_users', (table) => {
      table.id();
      table.string('name');
      table.string('email').unique();
      table.string('role', 16).default('viewer');
      table.string('password').secret();
      table.string('session_key', 64).nullable().secret();
      table.timestamps();
    }),
  down: (schema) => schema.drop('office_users'),
});

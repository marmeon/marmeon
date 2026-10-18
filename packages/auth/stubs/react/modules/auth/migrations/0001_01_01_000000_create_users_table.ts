import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('users', (table) => {
      table.id();
      table.string('name');
      table.string('email').unique();
      // A PHC string (argon2id); never in `Row<'users'>`, never in a select-all result.
      table.string('password').secret();
      // A random value `auth.updateSessionKey()` and `AccountSessions` replace to end the account's sessions (the first all but the
      // current one, the second every one); the session's fingerprint contains it. Secret: never in `Row<'users'>`.
      table.string('session_key', 64).nullable().secret();
      table.timestamp('email_verified_at').nullable();
      // When the account confirmed an address for the first time — set once, never cleared. A change of address with
      // AUTH_PRIVATE_REGISTRATION=false empties `email_verified_at` (the new address is unconfirmed), this stays:
      // `auth:prune-unverified` never deletes an account that was confirmed once.
      table.timestamp('first_verified_at').nullable();
      // The language the account was made in (or chose): mails reach the user in it.
      table.string('locale', 35).nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('users'),
});

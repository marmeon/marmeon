import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('users', (table) => {
      table.id();
      table.string('name');
      table.string('email').unique();
      // A PHC string (argon2id); never in `Row<'users'>`, never in a select-all result.
      table.string('password').secret();
      table.timestamp('email_verified_at').nullable();
      // When the account confirmed an address for the first time — set once, never cleared. A change of address with
      // AUTH_PRIVATE_REGISTRATION=false empties `email_verified_at` (the new address is unconfirmed), this stays:
      // `auth:prune-unverified` never deletes an account that was confirmed once.
      table.timestamp('first_verified_at').nullable();
      // The language the account was made in (or chose): mails reach the user in it.
      table.string('locale', 35).nullable();
      // A pending change of address (private registration): the new address waits beside the old one until the link sent to
      // it is clicked — `pending_email` signs nobody in. The link's token is kept as a SHA-256 hash, secret (never in `Row<'users'>`).
      table.string('pending_email', 255).nullable();
      table.string('pending_email_token', 64).nullable().secret();
      table.timestamp('pending_email_expires_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('users'),
});

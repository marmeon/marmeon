import { defineMigration } from '@marmeon/database';

// The remember-me token of a device lives on the row of its sign-in (`sign_ins`) now, and the table that held them goes. The tokens
// are not copied: the upgrade ends every session once (the session fingerprint changed with it), and every "keep me signed in"
// cookie signs in again only after the password.
export default defineMigration({
  up: (schema) => schema.drop('remember_tokens'),
  down: (schema) =>
    schema.create('remember_tokens', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('selector', 32).unique();
      table.string('validator_hash', 64).secret();
      table.string('previous_validator_hash', 64).nullable().secret();
      table.timestamp('rotated_at').nullable();
      table.timestamp('last_used_at').nullable();
      table.timestamp('expires_at');
      table.string('account_fingerprint', 64).nullable();
      table.timestamps();
    }),
});

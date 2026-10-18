// @marmeon-stub auth 5
import { defineMigration } from '@marmeon/database';

// A change of address that waits for its link: one row per account, apart from `users` so that no other module reads an address its
// owner has not confirmed. The link's token is kept only as a SHA-256 hash, and the account's session key at the time of the request
// bounds the link: replacing the key (a new password, signing out the other devices) ends it. Both are secrets, never in `selectAll()`.
export default defineMigration({
  up: (schema) =>
    schema.create('email_changes', (table) => {
      table.foreignId('user_id').constrained().cascadeOnDelete().primary();
      table.string('email', 255);
      table.string('token_hash', 64).secret();
      table.string('session_key', 64).nullable().secret();
      table.timestamp('expires_at');
      table.timestamp('created_at');
    }),
  down: (schema) => schema.drop('email_changes'),
});

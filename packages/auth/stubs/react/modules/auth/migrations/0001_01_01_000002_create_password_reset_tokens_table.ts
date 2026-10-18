// @marmeon-stub auth 5
import { defineMigration } from '@marmeon/database';

// One reset token per e-mail, only as a hash: the plain token exists only in the mail.
export default defineMigration({
  up: (schema) =>
    schema.create('password_reset_tokens', (table) => {
      table.string('email').primary();
      table.string('token_hash', 64).secret();
      table.timestamp('created_at');
    }),
  down: (schema) => schema.drop('password_reset_tokens'),
});

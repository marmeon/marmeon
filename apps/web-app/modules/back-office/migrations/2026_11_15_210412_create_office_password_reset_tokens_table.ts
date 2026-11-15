import { defineMigration } from '@marmeon/database';

// The reset links of the back office's guard: the shape of the app's `password_reset_tokens`. The token is kept only as its hash.
export default defineMigration({
  up: (schema) =>
    schema.create('office_password_reset_tokens', (table) => {
      table.string('email').primary();
      table.string('token_hash', 64).secret();
      table.timestamp('created_at');
    }),
  down: (schema) => schema.drop('office_password_reset_tokens'),
});

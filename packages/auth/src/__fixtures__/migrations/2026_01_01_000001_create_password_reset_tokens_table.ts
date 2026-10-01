import { defineMigration } from '@bespokecore/database';

export default defineMigration({
  up: (schema) =>
    schema.create('password_reset_tokens', (table) => {
      table.string('email').primary();
      table.string('token_hash', 64).secret();
      table.timestamp('created_at');
    }),
  down: (schema) => schema.drop('password_reset_tokens'),
});

import { defineMigration } from '@marmeon/database';

// The two columns the stores read on the account — the package tests keep their users in memory, apart from the tests of the stores that join them.
export default defineMigration({
  up: (schema) =>
    schema.create('users', (table) => {
      table.bigInteger('id').primary();
      table.string('session_key', 64).nullable().secret();
    }),
  down: (schema) => schema.drop('users'),
});

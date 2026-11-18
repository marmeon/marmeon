import { defineMigration } from '@marmeon/database';

// A `users` table with only the `id` that the foreign key of `social_accounts` needs.
export default defineMigration({
  up: (schema) =>
    schema.create('users', (table) => {
      table.id();
    }),
  down: (schema) => schema.drop('users'),
});

import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) => schema.alter('users', (table) => table.timestamp('email_verified_at').nullable()),
  down: (schema) => schema.alter('users', (table) => table.dropColumn('email_verified_at')),
});

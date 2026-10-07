import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('people', (table) => {
      table.id();
      table.string('email');
      table.string('password').nullable().secret();
    }),
  down: (schema) => schema.drop('people'),
});

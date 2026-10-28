import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('workshops', (table) => {
      table.id();
      table.integer('capacity');
    }),
  down: (schema) => schema.drop('workshops'),
});

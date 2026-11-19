import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('second_checked', (table) => {
      table.id();
    }),
  down: (schema) => schema.drop('second_checked'),
});

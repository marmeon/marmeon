import { defineMigration } from '../../../index.ts';

// Sorts between the two migrations of `order` and touches no table they touch.
export default defineMigration({
  up: (schema) =>
    schema.create('extras', (table) => {
      table.id();
      table.string('note');
    }),
  down: (schema) => schema.drop('extras'),
});

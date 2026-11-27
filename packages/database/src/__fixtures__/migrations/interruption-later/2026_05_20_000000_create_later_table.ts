import { defineMigration } from '../../../index.ts';

// Sorts after the migrations of the other interruption fixtures: it runs last.
export default defineMigration({
  up: (schema) => schema.create('later', (table) => table.id()),
  down: (schema) => schema.drop('later'),
});

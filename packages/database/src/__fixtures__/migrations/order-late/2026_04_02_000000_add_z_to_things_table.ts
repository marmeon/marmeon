import { defineMigration } from '../../../index.ts';

// Sorts between the two migrations of `order`, and is meant to have been merged after they ran: it adds back what the later one dropped.
export default defineMigration({
  up: (schema) =>
    schema.alter('things', (table) => {
      table.string('z').nullable().secret();
    }),
});

import { defineMigration } from '../../../index.ts';

// No down(): a rollback that reaches it must stop before it undoes anything.
export default defineMigration({
  up: (schema) =>
    schema.create('first_one_way', (table) => {
      table.id();
    }),
});

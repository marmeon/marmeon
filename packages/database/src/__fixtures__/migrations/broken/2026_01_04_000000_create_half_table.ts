import { defineMigration } from '../../../index.ts';

// Creates a table, then fails: the migration's transaction must undo the table too.
export default defineMigration({
  up: async (schema) => {
    await schema.create('half', (table) => table.id());
    throw new Error('this migration is broken');
  },
});

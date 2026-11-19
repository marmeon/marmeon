import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.alter('pets', (table) => {
      table.foreignId('owner_id').constrained('owners').cascadeOnDelete();
    }),
});

import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('owners', (table) => {
      table.id();
      table.string('name');
    });
    schema.create('pets', (table) => {
      table.id();
      table.foreignId('owner_id').constrained().cascadeOnDelete();
    });
  },
  down: (schema) => {
    schema.drop('pets');
    schema.drop('owners');
  },
});

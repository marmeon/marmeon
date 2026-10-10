import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('categories', (table) => {
      table.id();
      table.string('name');
      // A foreign key to its own table, without a name for the way back.
      table.foreignId('parent_id').constrained('categories').nullOnDelete().nullable();
    }),
  down: (schema) => schema.drop('categories'),
});

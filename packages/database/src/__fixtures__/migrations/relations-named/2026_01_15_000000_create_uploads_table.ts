import { defineMigration } from '../../../index.ts';

// The same table with the column named for its relation.
export default defineMigration({
  up: (schema) =>
    schema.create('uploads', (table) => {
      table.id();
      table.foreignId('uploaded_by_id').constrained('users').nullOnDelete().nullable();
      table.string('name');
    }),
  down: (schema) => schema.drop('uploads'),
});

import { defineMigration } from '../../../index.ts';

// A foreign key without `_id`: its relation would be named "uploaded_by" like the column.
export default defineMigration({
  up: (schema) =>
    schema.create('uploads', (table) => {
      table.id();
      table.foreignId('uploaded_by').constrained('users').nullOnDelete().nullable();
      table.string('name');
    }),
  down: (schema) => schema.drop('uploads'),
});

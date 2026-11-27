import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('shelves', (table) => {
      table.id();
      table.string('name');
    });
    // A related table whose primary key is the caller's text, and one without a primary key.
    schema.create('shelf_notes', (table) => {
      table.string('slug', 40).primary();
      table.foreignId('shelf_id').constrained('shelves');
      table.string('body').nullable();
    });
    schema.create('shelf_marks', (table) => {
      table.foreignId('shelf_id').constrained('shelves');
      table.string('mark');
    });
  },
  down: (schema) => {
    schema.drop('shelf_marks');
    schema.drop('shelf_notes');
    schema.drop('shelves');
  },
});

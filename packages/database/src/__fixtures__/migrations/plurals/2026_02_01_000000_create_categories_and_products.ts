import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('categories', (table) => {
      table.id();
      table.string('name');
    });
    schema.create('products', (table) => {
      table.id();
      // The table is not named: `category_id` is guessed as `categories`.
      table.foreignId('category_id').constrained().cascadeOnDelete();
      table.string('title');
    });
  },
  down: (schema) => {
    schema.drop('products');
    schema.drop('categories');
  },
});

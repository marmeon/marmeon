import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: async (schema) => {
    await schema.create('categories', (table) => {
      table.id();
      table.string('name');
    });
    await schema.create('products', (table) => {
      table.id();
      // The table is not named: `category_id` is guessed as `categories`.
      table.foreignId('category_id').constrained().cascadeOnDelete();
      table.string('title');
    });
  },
  down: async (schema) => {
    await schema.drop('products');
    await schema.drop('categories');
  },
});

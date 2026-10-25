import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    // The key is the slug, not an `id`.
    schema.create('pages', (table) => {
      table.string('slug').primary();
      table.string('title');
    }),
  down: (schema) => schema.drop('pages'),
});

import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('slugs', (table) => {
      table.id();
      table.string('slug').nullable();
      table.string('note');
      table.string('scrap').nullable();
    }),
  down: (schema) => schema.drop('slugs'),
});

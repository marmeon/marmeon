import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('things', (table) => {
      table.id();
      table.string('label');
      table.string('z').nullable();
    }),
  down: (schema) => schema.drop('things'),
});

import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('limit_notes', (table) => {
      table.id();
      table.text('body');
      table.string('title');
    }),
  down: (schema) => schema.drop('limit_notes'),
});

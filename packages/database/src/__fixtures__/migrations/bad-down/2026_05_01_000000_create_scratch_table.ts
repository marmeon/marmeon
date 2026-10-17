import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('scratch', (table) => {
      table.id();
      table.string('kept');
    }),
  down: (schema) => schema.drop('scratch'),
});

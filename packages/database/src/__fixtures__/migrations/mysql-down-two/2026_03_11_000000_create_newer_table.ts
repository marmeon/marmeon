import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('newer', (table) => {
      table.id();
    }),
  down: (schema) => schema.drop('newer'),
});

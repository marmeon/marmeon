import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('before_refused', (table) => {
      table.id();
    }),
});

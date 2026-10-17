import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.alter('things', (table) => {
      table.dropColumn('z');
    }),
});

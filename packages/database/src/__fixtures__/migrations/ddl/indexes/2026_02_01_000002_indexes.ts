import { defineMigration } from '../../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('ddl_indexed', (table) => {
      table.id();
      table.string('a');
      table.string('b');
      table.string('c').unique();
      table.index('a');
      table.index(['a', 'b']);
      table.index('b', 'ddl_indexed_named_b');
      table.unique('a');
      table.unique(['a', 'b'], 'ddl_indexed_named_ab');
    }),
  down: (schema) => schema.drop('ddl_indexed'),
});

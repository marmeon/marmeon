import { defineMigration } from '../../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.alter('ddl_indexed', (table) => table.dropIndex('ddl_indexed_d_index'));
    schema.alter('ddl_indexed', (table) => table.dropColumn('d'));
  },
  down: () => {},
});

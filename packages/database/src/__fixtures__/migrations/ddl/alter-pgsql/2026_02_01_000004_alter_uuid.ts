import { defineMigration } from '../../../../index.ts';

// SQLite adds no column whose default is computed: this group is loaded on Postgres only.
export default defineMigration({
  up: (schema) => schema.alter('ddl_indexed', (table) => table.uuid('public_id').useUuidv7()),
  down: () => {},
});

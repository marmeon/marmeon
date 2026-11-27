import { defineMigration, sql } from '../../../index.ts';

// A down() that drops one table and then fails (1051: the other table does not exist).
export default defineMigration({
  up: (schema) => {
    schema.create('gadgets', (table) => table.id());
    schema.create('gizmos', (table) => table.id());
  },
  down: (schema) => {
    schema.drop('gizmos');
    schema.raw(sql`drop table no_such_table`);
  },
});

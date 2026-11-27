import { defineMigration, sql } from '../../../index.ts';

// On the connection "system": creates a table, then runs a statement the server refuses (1051).
export default defineMigration({
  connection: 'system',
  up: (schema) => {
    schema.create('audit', (table) => table.id());
    schema.raw(sql`drop table no_such_table`);
  },
});

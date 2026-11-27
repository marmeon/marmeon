import { defineMigration, sql } from '../../../index.ts';

// Changes the rows, adds a column, then runs a statement the server refuses (1060: the column is there already).
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await sql`update counter set n = n * 100`.execute(db);
    });
    schema.alter('counter', (table) => {
      table.string('note').nullable();
    });
    schema.raw(sql`alter table counter add column note varchar(10)`);
  },
  down: (schema) => {
    schema.alter('counter', (table) => table.dropColumn('note'));
  },
});

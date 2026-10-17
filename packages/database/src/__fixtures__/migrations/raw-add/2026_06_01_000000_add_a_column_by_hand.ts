import { defineMigration, sql } from '../../../index.ts';

// Adds a column and a table in raw SQL: the migrations do not know them.
export default defineMigration({
  up: (schema) => {
    schema.raw(sql`alter table accounts add column by_hand text`);
    schema.raw(sql`create table made_by_hand (id integer primary key)`);
  },
});

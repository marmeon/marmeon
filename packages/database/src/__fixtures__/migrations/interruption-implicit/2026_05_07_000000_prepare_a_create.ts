import { defineMigration, sql } from '../../../index.ts';

// Rows alone as far as the plan shows, but a prepared statement commits on its own: the guard of a data step does not read what a string holds.
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await sql`update counter set n = n * 100`.execute(db);
      await sql`prepare s from 'create table sneaked (id integer)'`.execute(db);
      await sql`execute s`.execute(db);
      await sql`deallocate prepare s`.execute(db);
    });
  },
});

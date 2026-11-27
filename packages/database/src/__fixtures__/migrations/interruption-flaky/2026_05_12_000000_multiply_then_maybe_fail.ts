import { defineMigration, sql } from '../../../index.ts';

// Changes the rows, then runs a statement the server refuses (1051) while `globalThis.interruptionFails` is true, or adds a column when it is not.
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await sql`update counter set n = n * 100`.execute(db);
    });
    schema.raw((globalThis as { interruptionFails?: boolean }).interruptionFails === true ? sql`drop table no_such_table` : sql`alter table counter add column note varchar(10)`);
  },
  down: (schema) => {
    schema.raw(sql`alter table counter drop column note`);
  },
});

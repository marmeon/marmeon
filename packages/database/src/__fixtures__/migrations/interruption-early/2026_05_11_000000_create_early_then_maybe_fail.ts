import { defineMigration, sql } from '../../../index.ts';

// Sorts before the flaky migration: creates a table, then runs a statement the server refuses (1051) while `globalThis.interruptionFails` is true.
export default defineMigration({
  up: (schema) => {
    schema.create('early', (table) => table.id());
    schema.raw((globalThis as { interruptionFails?: boolean }).interruptionFails === true ? sql`drop table no_such_table` : sql`select 1`);
  },
  down: (schema) => schema.drop('early'),
});

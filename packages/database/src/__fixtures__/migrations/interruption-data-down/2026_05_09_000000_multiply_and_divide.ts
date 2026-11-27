import { defineMigration, sql } from '../../../index.ts';

// Rows alone in both directions.
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await sql`update counter set n = n * 100`.execute(db);
    });
  },
  down: (schema) => {
    schema.data(async (db) => {
      await sql`update counter set n = n / 100`.execute(db);
    });
  },
});

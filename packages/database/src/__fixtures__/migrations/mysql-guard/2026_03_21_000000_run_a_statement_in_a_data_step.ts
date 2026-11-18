import { defineMigration, sql } from '../../../index.ts';

// Changes the rows, then runs the statement the test names: a statement that commits would keep the change.
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await db.updateTable('ledger').set({ amount: 99 }).execute();
      await sql.raw((globalThis as { guardedStatement?: string }).guardedStatement ?? 'select 1').execute(db);
    });
  },
});

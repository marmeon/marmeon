import { defineMigration } from '../../../index.ts';

// Changes every row, then fails: the rows of a data step go with its transaction, the table around it is not undone.
export default defineMigration({
  up: (schema) => {
    schema.alter('ledger', (table) => {
      table.string('note').nullable();
    });
    schema.data(async (db) => {
      await db.updateTable('ledger').set({ amount: 99 }).execute();
      throw new Error('the backfill failed');
    });
  },
});

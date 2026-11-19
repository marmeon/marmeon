import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('ledger', (table) => {
      table.id();
      table.integer('amount');
    });
    schema.data(async (db) => {
      await db.insertInto('ledger').values([{ amount: 10 }, { amount: 20 }]).execute();
    });
  },
});

import { defineMigration } from '../../../index.ts';

// Data steps that succeed, with a schema change after each: the next step runs on the connection the data step's transaction ended on.
export default defineMigration({
  up: (schema) => {
    schema.create('ledger', (table) => {
      table.id();
      table.integer('amount');
    });
    schema.data(async (db) => {
      await db.insertInto('ledger').values([{ amount: 10 }, { amount: 20 }]).execute();
    });
    schema.alter('ledger', (table) => {
      table.string('note').nullable();
    });
    schema.data(async (db) => {
      await db.updateTable('ledger').set({ note: 'raised' }).execute();
    });
  },
  down: (schema) => schema.drop('ledger'),
});

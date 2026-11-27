import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('counter', (table) => {
      table.id();
      table.integer('n');
    });
    schema.data(async (db) => {
      await db.insertInto('counter').values({ n: 1 }).execute();
    });
  },
  down: (schema) => schema.drop('counter'),
});

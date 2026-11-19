import { defineMigration } from '../../../index.ts';

// Its down() makes a column NOT NULL (SQLite cannot) and names an index longer than Postgres allows: a driver refuses it before it runs.
export default defineMigration({
  up: (schema) =>
    schema.create('first_checked', (table) => {
      table.id();
      table.string('name').nullable();
    }),
  down: (schema) => {
    schema.alter('first_checked', (table) => {
      table.notNull('name');
      table.index(['name'], 'i'.repeat(70));
    });
    schema.drop('first_checked');
  },
});

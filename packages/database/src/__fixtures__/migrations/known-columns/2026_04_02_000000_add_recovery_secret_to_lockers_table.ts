import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.alter('lockers', (table) => {
      table.string('nickname').nullable();
      table.text('recovery_secret').nullable().secret();
    }),
  down: (schema) =>
    schema.alter('lockers', (table) => {
      table.dropColumn('recovery_secret');
      table.dropColumn('nickname');
    }),
});

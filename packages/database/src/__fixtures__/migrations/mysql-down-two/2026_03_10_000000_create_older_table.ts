import { defineMigration, sql } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('older', (table) => {
      table.id();
    }),
  // No statement for MySQL.
  down: (schema) => {
    schema.drop('older');
    schema.raw({ sqlite: sql`select 1`, pgsql: sql`select 1` });
  },
});

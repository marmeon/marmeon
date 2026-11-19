import { defineMigration, sql } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('keeps_down', (table) => {
      table.id();
    }),
  // No statement for MySQL: the rollback is refused before it drops anything.
  down: (schema) => {
    schema.drop('keeps_down');
    schema.raw({ sqlite: sql`select 1`, pgsql: sql`select 1` });
  },
});

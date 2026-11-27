import { defineMigration } from '../../../index.ts';

// The name the migrator keeps on MySQL: the app's own table on SQLite and Postgres.
export default defineMigration({
  up: (schema) =>
    schema.create('migration_interruption', (table) => {
      table.id();
      table.string('note');
    }),
  down: (schema) => schema.drop('migration_interruption'),
});

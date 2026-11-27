import { defineMigration } from '../../../index.ts';

// A harmless `up()`; the `down()` names the table the migrator keeps on MySQL.
export default defineMigration({
  up: (schema) =>
    schema.create('notes', (table) => {
      table.id();
    }),
  down: (schema) => schema.rename('migration_interruption', 'scratch'),
});

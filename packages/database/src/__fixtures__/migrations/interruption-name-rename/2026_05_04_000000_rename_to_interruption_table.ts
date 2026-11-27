import { defineMigration } from '../../../index.ts';

// Renames a table to the name the migrator keeps on MySQL.
export default defineMigration({
  up: (schema) => {
    schema.create('scratch', (table) => {
      table.id();
    });
    schema.rename('scratch', 'Migration_Interruption');
  },
});

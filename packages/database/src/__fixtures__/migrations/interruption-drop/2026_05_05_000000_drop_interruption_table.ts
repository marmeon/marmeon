import { defineMigration } from '../../../index.ts';

// Drops the name the migrator keeps on MySQL (a drop is accepted for a table no migration made).
export default defineMigration({
  up: (schema) => schema.drop('migration_interruption'),
});

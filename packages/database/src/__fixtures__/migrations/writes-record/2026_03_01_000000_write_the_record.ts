import { defineMigration } from '../../../index.ts';

// Writes to the lock of the migrator from a data step.
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await db.deleteFrom('migration_lock').execute();
    });
  },
});

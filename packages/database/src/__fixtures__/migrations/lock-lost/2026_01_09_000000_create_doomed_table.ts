import { defineMigration } from '../../../index.ts';

const lose = (db: unknown) => (globalThis as { loseMigrationLock?: (db: unknown) => Promise<void> }).loseMigrationLock?.(db);

/** Loses the migration lock while it runs: the test sets `loseMigrationLock`. */
export default defineMigration({
  up: (schema) => {
    schema.create('doomed', (table) => {
      table.id();
    });
    schema.data(async (db) => {
      await lose(db);
    });
  },
  down: (schema) => {
    schema.data(async (db) => {
      await lose(db);
    });
    schema.drop('doomed');
  },
});

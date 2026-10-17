import { defineMigration } from '../../../index.ts';

const lose = (db: unknown) => (globalThis as { loseMigrationLock?: (db: unknown) => Promise<void> }).loseMigrationLock?.(db);

/** Loses the migration lock while it runs: the test sets `loseMigrationLock`. */
export default defineMigration({
  up: async (schema) => {
    await schema.create('doomed', (table) => {
      table.id();
    });
    await lose(schema.db);
  },
  down: async (schema) => {
    await lose(schema.db);
    await schema.drop('doomed');
  },
});

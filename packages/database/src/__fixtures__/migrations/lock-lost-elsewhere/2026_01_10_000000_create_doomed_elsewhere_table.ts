import { defineMigration } from '../../../index.ts';

const lose = (db: unknown) => (globalThis as { loseMigrationLock?: (db: unknown) => Promise<void> }).loseMigrationLock?.(db);

/** The same on the connection `system`: the test sets `loseMigrationLock`. */
export default defineMigration({
  connection: 'system',
  up: (schema) => {
    schema.create('doomed_elsewhere', (table) => {
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
    schema.drop('doomed_elsewhere');
  },
});

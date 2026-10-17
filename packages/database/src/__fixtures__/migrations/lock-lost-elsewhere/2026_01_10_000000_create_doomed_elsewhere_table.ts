import { defineMigration } from '../../../index.ts';

const lose = (db: unknown) => (globalThis as { loseMigrationLock?: (db: unknown) => Promise<void> }).loseMigrationLock?.(db);

/** The same on the connection `system`: the test sets `loseMigrationLock`. */
export default defineMigration({
  connection: 'system',
  up: async (schema) => {
    await schema.create('doomed_elsewhere', (table) => {
      table.id();
    });
    await lose(schema.db);
  },
  down: async (schema) => {
    await lose(schema.db);
    await schema.drop('doomed_elsewhere');
  },
});

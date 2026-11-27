import { defineMigration, sql } from '../../../index.ts';

/** Only rows change: the test sets `loseMigrationLock` to end the migration's lock after the update. */
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await sql`update counter set n = n * 100`.execute(db);
      await (globalThis as { loseMigrationLock?: (db: unknown) => Promise<void> }).loseMigrationLock?.(db);
    });
  },
});

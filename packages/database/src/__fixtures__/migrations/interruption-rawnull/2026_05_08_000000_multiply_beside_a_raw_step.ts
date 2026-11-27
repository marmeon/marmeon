import { defineMigration, sql } from '../../../index.ts';

// Rows alone on MySQL: the raw step has nothing for it. The test sets `loseMigrationLock` to end the migration's lock after the update.
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await sql`update counter set n = n * 100`.execute(db);
    });
    schema.raw({ sqlite: sql`select 1`, pgsql: sql`select 1`, mysql: null });
    schema.data(async (db) => {
      await (globalThis as { loseMigrationLock?: (db: unknown) => Promise<void> }).loseMigrationLock?.(db);
    });
  },
});

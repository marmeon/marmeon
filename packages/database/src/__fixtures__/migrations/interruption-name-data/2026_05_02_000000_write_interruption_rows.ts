import { defineMigration } from '../../../index.ts';

// Writes to the migrator's table of interruptions from a data step: refused on MySQL, where that is the migrator's.
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await db.insertInto('migration_interruption').values({ name: 'x' }).execute();
    });
  },
});

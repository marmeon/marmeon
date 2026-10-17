import { defineMigration, sql } from '../../../index.ts';

// Renames a secret column in raw SQL: the entry in the bookkeeping would stay with a name that is gone.
export default defineMigration({
  up: async (schema) => {
    await sql`alter table accounts rename column password to pw`.execute(schema.db);
  },
});

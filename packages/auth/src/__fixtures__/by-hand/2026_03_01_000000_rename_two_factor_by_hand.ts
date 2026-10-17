import { defineMigration, sql } from '@marmeon/database';

// Renames a table with a secret column in raw SQL: its entry in the bookkeeping would stay with the old name.
export default defineMigration({
  up: async (schema) => {
    await sql`alter table marmeon_two_factor_authentications rename to two_factor_authentications`.execute(schema.db);
  },
});

import { defineMigration, sql } from '../../../index.ts';

// Renames a table with secret columns in raw SQL: its entries in the bookkeeping would stay with the old name.
export default defineMigration({
  up: async (schema) => {
    await sql`alter table accounts rename to people`.execute(schema.db);
  },
});

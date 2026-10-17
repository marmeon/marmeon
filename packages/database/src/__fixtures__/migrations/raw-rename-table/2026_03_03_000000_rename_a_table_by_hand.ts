import { defineMigration, sql } from '../../../index.ts';

// Renames a table with secret columns in raw SQL: the schema the migrations describe would keep the old name.
export default defineMigration({
  up: (schema) => {
    schema.raw(sql`alter table accounts rename to people`);
  },
});

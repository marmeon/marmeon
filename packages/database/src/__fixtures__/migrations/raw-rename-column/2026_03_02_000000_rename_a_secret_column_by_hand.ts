import { defineMigration, sql } from '../../../index.ts';

// Renames a secret column in raw SQL: the schema the migrations describe would keep a column that is gone, and `pw` would be read as an ordinary one.
export default defineMigration({
  up: (schema) => {
    schema.raw(sql`alter table accounts rename column password to pw`);
  },
});

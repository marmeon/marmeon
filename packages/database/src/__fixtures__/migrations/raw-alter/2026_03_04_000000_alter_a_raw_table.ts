import { sql } from 'kysely';
import { defineMigration } from '../../../index.ts';

// A table raw SQL made, then changed with the blueprint: Marmeon would not know the secret column.
export default defineMigration({
  up: (schema) => {
    schema.raw(sql`create table legacy (id integer primary key)`);
    schema.alter('legacy', (table) => {
      table.string('token').secret();
    });
  },
});

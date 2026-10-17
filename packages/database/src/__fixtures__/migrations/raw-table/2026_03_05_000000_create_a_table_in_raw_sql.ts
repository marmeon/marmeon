import { sql } from 'kysely';
import { defineMigration } from '../../../index.ts';

// A table raw SQL made next to one the blueprint made: only the second is known to Marmeon, so only it has a type.
export default defineMigration({
  up: (schema) => {
    schema.raw(sql`create table legacy (id integer primary key, note text)`);
    schema.create('notes', (table) => {
      table.id();
      table.string('title');
    });
  },
  down: (schema) => {
    schema.drop('notes');
    schema.raw(sql`drop table legacy`);
  },
});

import { sql } from 'kysely';
import { defineMigration } from '../../../index.ts';

// "aa_zebras" sorts before "zebras": a drop that walks the names in order meets the view first.
export default defineMigration({
  up: (schema) => {
    schema.raw(sql`create table zebras (id integer primary key, name text)`);
    schema.raw(sql`create view aa_zebras as select id, name from zebras`);
  },
  down: (schema) => {
    schema.raw(sql`drop view aa_zebras`);
    schema.raw(sql`drop table zebras`);
  },
});

import { defineMigration, sql } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    // Nothing on MySQL, said on purpose.
    schema.raw({ sqlite: sql`create table only_elsewhere (id integer)`, pgsql: sql`create table only_elsewhere (id integer)`, mysql: null });
    schema.raw({ mysql: sql`create table from_mysql (id integer primary key)` });
    schema.raw(sql`create table from_both (id integer primary key)`);
  },
  down: (schema) => {
    schema.raw({ mysql: sql`drop table from_mysql` });
    schema.raw(sql`drop table from_both`);
  },
});

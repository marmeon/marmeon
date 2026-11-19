import { defineMigration, sql } from '../../../index.ts';

// A statement for SQLite and one for Postgres, none for MySQL.
export default defineMigration({
  up: (schema) => {
    schema.raw({ sqlite: sql`create table not_for_mysql (id integer)`, pgsql: sql`create table not_for_mysql (id integer)` });
  },
});

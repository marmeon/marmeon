import { defineMigration, sql } from '../../../index.ts';

// On `default`: the only step has nothing to send to MySQL, so it writes no marker of its own.
export default defineMigration({
  up: (schema) => schema.raw({ sqlite: sql`select 1`, pgsql: sql`select 1`, mysql: null }),
});

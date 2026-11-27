import { defineMigration, sql } from '../../../index.ts';

// On the connection "system": the only step has nothing to send to MySQL.
export default defineMigration({
  connection: 'system',
  up: (schema) => schema.raw({ sqlite: sql`select 1`, pgsql: sql`select 1`, mysql: null }),
});

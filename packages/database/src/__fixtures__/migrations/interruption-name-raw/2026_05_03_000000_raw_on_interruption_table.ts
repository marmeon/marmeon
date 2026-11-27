import { defineMigration, sql } from '../../../index.ts';

// Raw SQL for MySQL that names the migrator's table of interruptions.
export default defineMigration({
  up: (schema) => {
    schema.raw({ mysql: sql`delete from migration_interruption` });
  },
});

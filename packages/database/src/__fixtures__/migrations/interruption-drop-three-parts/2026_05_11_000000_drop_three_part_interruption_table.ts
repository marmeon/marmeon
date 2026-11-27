import { defineMigration } from '../../../index.ts';

// Kysely sends a three-part name as `app`.`migration_interruption`: the table is the middle part, not the last.
export default defineMigration({
  up: (schema) => schema.drop('app.migration_interruption.x'),
});

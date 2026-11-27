import { defineMigration } from '../../../index.ts';

// The same table by a name with its database in front.
export default defineMigration({
  up: (schema) => schema.drop('app.migration_interruption'),
});

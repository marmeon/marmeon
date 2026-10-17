import { defineMigration, sql } from '../../../index.ts';

// Its down() takes a column of the migration before it along: the database no longer fits what the remaining migrations say.
export default defineMigration({
  up: (schema) =>
    schema.create('leftovers', (table) => {
      table.id();
    }),
  down: (schema) => {
    schema.drop('leftovers');
    schema.raw(sql`alter table scratch drop column kept`);
  },
});

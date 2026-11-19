import { defineMigration } from '../../../index.ts';

// The down() of this migration cannot run on MySQL (nullable() is refused): the rollback says so before it rolls back anything.
export default defineMigration({
  up: (schema) =>
    schema.create('rq_a', (table) => {
      table.id();
      table.string('x');
    }),
  down: (schema) => schema.alter('rq_a', (table) => table.nullable('x')),
});

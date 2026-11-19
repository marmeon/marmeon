import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => schema.create('rq_b', (table) => table.id()),
  down: (schema) => schema.drop('rq_b'),
});

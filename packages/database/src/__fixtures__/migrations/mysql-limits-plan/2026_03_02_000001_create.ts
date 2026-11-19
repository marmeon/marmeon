import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => schema.create('lp_a', (table) => table.id()),
  down: (schema) => schema.drop('lp_a'),
});

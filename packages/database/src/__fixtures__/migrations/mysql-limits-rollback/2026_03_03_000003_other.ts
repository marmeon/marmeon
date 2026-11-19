import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => schema.create('rb_other', (table) => table.id()),
  down: (schema) => schema.drop('rb_other'),
});

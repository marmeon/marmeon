import { defineMigration } from '../../../index.ts';

export default defineMigration({
  connection: 'system',
  up: (schema) => schema.create('metrics', (table) => table.id()),
  down: (schema) => schema.drop('metrics'),
});

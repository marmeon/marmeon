import { defineMigration } from '../../../index.ts';

export default defineMigration({
  connection: 'system',
  up: (schema) => schema.create('audit', (table) => table.id()),
  down: (schema) => schema.drop('audit'),
});

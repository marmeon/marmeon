import { defineMigration } from '../../../index.ts';

export default defineMigration({
  connection: 'reporting',
  up: (schema) => schema.create('reports', (table) => table.id()),
});

import { defineMigration } from '../../../index.ts';

// The column a foreign key points at is renamed: the database moves the reference with it.
export default defineMigration({
  up: (schema) => schema.alter('owners', (table) => table.renameColumn('id', 'key')),
  down: (schema) => schema.alter('owners', (table) => table.renameColumn('key', 'id')),
});

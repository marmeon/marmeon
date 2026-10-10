import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => schema.alter('notes', (table) => table.dropColumn('deleted_at')),
  down: (schema) => schema.alter('notes', (table) => table.softDeletes()),
});

import { defineMigration } from '../../../index.ts';

// A renamed `updated_at` or `deleted_at` is no timestamp or soft delete any more — renaming it back does not mark the table again.
export default defineMigration({
  up: (schema) => {
    schema.alter('notes', (table) => table.renameColumn('updated_at', 'changed_at'));
    schema.alter('notes', (table) => table.softDeletes());
    schema.alter('notes', (table) => table.renameColumn('deleted_at', 'removed_at'));
  },
  down: (schema) => {
    schema.alter('notes', (table) => table.renameColumn('removed_at', 'deleted_at'));
    schema.alter('notes', (table) => table.dropColumn('deleted_at'));
    schema.alter('notes', (table) => table.renameColumn('changed_at', 'updated_at'));
  },
});

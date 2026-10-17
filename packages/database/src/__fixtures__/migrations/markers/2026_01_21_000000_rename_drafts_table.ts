import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.rename('drafts', 'notes');
    schema.alter('notes', (table) => table.renameColumn('writer_id', 'author_id'));
  },
  down: (schema) => {
    schema.alter('notes', (table) => table.renameColumn('author_id', 'writer_id'));
    schema.rename('notes', 'drafts');
  },
});

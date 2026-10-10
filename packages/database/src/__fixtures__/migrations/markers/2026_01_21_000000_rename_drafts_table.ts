import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: async (schema) => {
    await schema.rename('drafts', 'notes');
    await schema.alter('notes', (table) => table.renameColumn('writer_id', 'author_id'));
  },
  down: async (schema) => {
    await schema.alter('notes', (table) => table.renameColumn('author_id', 'writer_id'));
    await schema.rename('notes', 'drafts');
  },
});

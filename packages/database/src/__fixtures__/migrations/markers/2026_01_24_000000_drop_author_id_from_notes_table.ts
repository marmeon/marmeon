import { defineMigration } from '../../../index.ts';

// A dropped foreign key column takes its inverse name with it. SQLite cannot drop a column a foreign key uses: Postgres only.
export default defineMigration({
  up: async (schema) => {
    if (schema.driver === 'pgsql') await schema.alter('notes', (table) => table.dropColumn('author_id'));
  },
  down: async (schema) => {
    if (schema.driver !== 'pgsql') return;
    await schema.alter('notes', (table) => {
      table.foreignId('author_id').constrained('users').cascadeOnDelete().inverse('written_drafts').nullable();
    });
  },
});

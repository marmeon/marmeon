import { defineMigration } from '../../../index.ts';

// A dropped foreign key column takes its inverse name with it. SQLite cannot drop a column a foreign key uses: this group is
// loaded on Postgres only.
export default defineMigration({
  up: (schema) => schema.alter('notes', (table) => table.dropColumn('author_id')),
  down: (schema) => {
    schema.alter('notes', (table) => {
      table.foreignId('author_id').constrained('users').cascadeOnDelete().inverse('written_drafts').nullable();
    });
  },
});

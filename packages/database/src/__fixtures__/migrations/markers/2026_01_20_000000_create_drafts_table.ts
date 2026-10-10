import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('drafts', (table) => {
      table.id();
      table.foreignId('writer_id').constrained('users').cascadeOnDelete().inverse('written_drafts');
      table.string('title');
      table.timestamps();
      table.softDeletes();
    }),
  down: (schema) => schema.drop('drafts'),
});

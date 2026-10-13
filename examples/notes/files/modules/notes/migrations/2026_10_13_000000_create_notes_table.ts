import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('notes', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('title', 120);
      table.text('body');
      table.boolean('pinned').default(false);
      table.timestamps();
    }),
  down: (schema) => schema.drop('notes'),
});

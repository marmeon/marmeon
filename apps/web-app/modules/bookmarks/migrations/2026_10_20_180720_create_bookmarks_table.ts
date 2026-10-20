import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('bookmarks', (table) => {
      // A UUIDv7 as the primary key: the id is in URLs, and the next one cannot be guessed.
      table.uuidId();
      table.foreignId('user_id').constrained('users').cascadeOnDelete();
      table.string('title', 120);
      table.timestamps();
      table.index('user_id');
    }),
  down: (schema) => schema.drop('bookmarks'),
});

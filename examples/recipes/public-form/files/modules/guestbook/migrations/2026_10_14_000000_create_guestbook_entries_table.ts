import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('guestbook_entries', (table) => {
      // A UUIDv7 as the primary key: the id is in URLs, and the next one cannot be guessed.
      table.uuidId();
      table.string('name', 60);
      table.string('message', 500);
      // Empty until somebody approves the entry; only approved entries are shown.
      table.timestamp('approved_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('guestbook_entries'),
});

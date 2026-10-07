import { defineMigration } from '@marmeon/database';

// Links people put on their profile (website, GitHub …) — the user-profile module's own table.
export default defineMigration({
  up: (schema) =>
    schema.create('profile_links', (table) => {
      table.id();
      table.foreignId('user_id').constrained('users').cascadeOnDelete();
      table.string('label', 60);
      table.string('url', 2048);
      table.timestamps();
      table.index('user_id');
    }),
  down: (schema) => schema.drop('profile_links'),
});

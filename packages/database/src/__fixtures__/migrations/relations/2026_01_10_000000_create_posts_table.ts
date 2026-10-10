import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('posts', (table) => {
      table.id();
      // Two foreign keys to `users`: each names the relation `users` gets back.
      table.foreignId('author_id').constrained('users').cascadeOnDelete().inverse('authored_posts');
      table.foreignId('editor_id').constrained('users').nullOnDelete().inverse('edited_posts').nullable();
      table.string('title');
      table.boolean('featured').default(false);
      table.decimal('rating', 4, 2).default('0');
      table.timestamp('published_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('posts'),
});

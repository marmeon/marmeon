import { defineMigration } from '../../../index.ts';

export default defineMigration({
  // The readers of a post: posts and users belong to many of each other — the users have soft deletes.
  up: (schema) =>
    schema.create('post_user', (table) => {
      table.foreignId('post_id').constrained().cascadeOnDelete();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.unique(['post_id', 'user_id']);
    }),
  down: (schema) => schema.drop('post_user'),
});

import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.create('tags', (table) => {
      table.id();
      table.string('slug').unique();
    });
    // Exactly two foreign keys, unique together: posts and tags belong to many of each other.
    schema.create('post_tag', (table) => {
      table.foreignId('post_id').constrained().cascadeOnDelete();
      table.foreignId('tag_id').constrained().cascadeOnDelete();
      table.unique(['post_id', 'tag_id']);
    });
  },
  down: (schema) => {
    schema.drop('post_tag');
    schema.drop('tags');
  },
});

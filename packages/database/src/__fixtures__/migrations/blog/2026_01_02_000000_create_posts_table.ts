import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('posts', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('title', 120);
      table.text('body').nullable();
      table.timestamp('published_at').nullable();
      table.index(['user_id', 'title']);
    }),
  down: (schema) => schema.drop('posts'),
});

import { defineMigration } from '../../../index.ts';

// The posts of the relations fixture without `.inverse()`: `users` would get two relations named `posts`.
export default defineMigration({
  up: (schema) =>
    schema.create('posts', (table) => {
      table.id();
      table.foreignId('author_id').constrained('users').cascadeOnDelete();
      table.foreignId('editor_id').constrained('users').nullOnDelete().nullable();
      table.string('title');
    }),
  down: (schema) => schema.drop('posts'),
});

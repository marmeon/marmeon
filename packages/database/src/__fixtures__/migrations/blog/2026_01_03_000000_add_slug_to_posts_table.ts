import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) => {
    schema.alter('posts', (table) => {
      table.string('slug').nullable();
      table.unique('slug');
      table.renameColumn('body', 'content');
    });
    schema.rename('posts', 'articles');
  },
  down: (schema) => {
    schema.rename('articles', 'posts');
    schema.alter('posts', (table) => {
      table.renameColumn('content', 'body');
      table.dropUnique('posts_slug_unique');
      table.dropColumn('slug');
    });
  },
});

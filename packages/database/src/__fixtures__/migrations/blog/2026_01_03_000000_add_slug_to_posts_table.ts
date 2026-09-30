import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: async (schema) => {
    await schema.alter('posts', (table) => {
      table.string('slug').nullable();
      table.unique('slug');
      table.renameColumn('body', 'content');
    });
    await schema.rename('posts', 'articles');
  },
  down: async (schema) => {
    await schema.rename('articles', 'posts');
    await schema.alter('posts', (table) => {
      table.renameColumn('content', 'body');
      table.dropUnique('posts_slug_unique');
      table.dropColumn('slug');
    });
  },
});

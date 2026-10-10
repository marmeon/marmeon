import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('post_stats', (table) => {
      // The foreign key is the primary key: at most one row per post.
      table.foreignId('post_id').primary().constrained().cascadeOnDelete();
      table.integer('views').default(0);
    }),
  down: (schema) => schema.drop('post_stats'),
});

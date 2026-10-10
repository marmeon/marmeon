import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('comments', (table) => {
      table.id();
      table.foreignId('post_id').constrained().cascadeOnDelete();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.text('body');
      table.boolean('approved').default(false);
      table.timestamps();
      table.softDeletes();
    }),
  down: (schema) => schema.drop('comments'),
});

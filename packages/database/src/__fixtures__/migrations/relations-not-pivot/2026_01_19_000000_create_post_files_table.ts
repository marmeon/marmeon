import { defineMigration } from '../../../index.ts';

export default defineMigration({
  // A file per user and post: unique together, but a record of its own, not a pivot.
  up: (schema) =>
    schema.create('post_files', (table) => {
      table.foreignId('post_id').constrained().cascadeOnDelete();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('path');
      table.unique(['post_id', 'user_id']);
      table.notPivot();
    }),
  down: (schema) => schema.drop('post_files'),
});

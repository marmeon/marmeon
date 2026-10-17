import { defineMigration } from '../../../index.ts';

export default defineMigration({
  // Posts and labels belong to many of each other — through a pivot with soft deletes, which relation writes refuse.
  up: (schema) => {
    schema.create('labels', (table) => {
      table.id();
      table.string('name');
    });
    schema.create('label_post', (table) => {
      table.foreignId('label_id').constrained().cascadeOnDelete();
      table.foreignId('post_id').constrained().cascadeOnDelete();
      table.unique(['label_id', 'post_id']);
      table.softDeletes();
    });
  },
  down: (schema) => {
    schema.drop('label_post');
    schema.drop('labels');
  },
});

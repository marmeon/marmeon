import { defineMigration } from '../../../index.ts';

export default defineMigration({
  // Posts and flags belong to many of each other, and the pivot keeps the time of each link.
  up: (schema) => {
    schema.create('flags', (table) => {
      table.id();
      table.string('label');
    });
    schema.create('flag_post', (table) => {
      table.foreignId('flag_id').constrained().cascadeOnDelete();
      table.foreignId('post_id').constrained().cascadeOnDelete();
      table.unique(['flag_id', 'post_id']);
      table.timestamps();
    });
  },
  down: (schema) => {
    schema.drop('flag_post');
    schema.drop('flags');
  },
});

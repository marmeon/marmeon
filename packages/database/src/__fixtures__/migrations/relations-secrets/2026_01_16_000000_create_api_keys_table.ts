import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('api_keys', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('name');
      table.string('token').secret();
    }),
  down: (schema) => schema.drop('api_keys'),
});

import { defineMigration } from '@bespokecore/database';

export default defineMigration({
  up: (schema) =>
    schema.create('users', (table) => {
      table.id();
      table.string('name');
      table.string('email').unique();
      table.text('bio').default('');
      table.timestamps();
    }),
  down: (schema) => schema.drop('users'),
});

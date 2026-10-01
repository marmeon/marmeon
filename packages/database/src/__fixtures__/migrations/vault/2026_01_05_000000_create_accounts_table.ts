import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('accounts', (table) => {
      table.id();
      table.string('email').unique();
      table.string('password').secret();
      table.string('api_secret').nullable().secret();
      table.timestamps();
    }),
  down: (schema) => schema.drop('accounts'),
});

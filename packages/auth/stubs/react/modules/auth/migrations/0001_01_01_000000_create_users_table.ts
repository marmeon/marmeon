import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('users', (table) => {
      table.id();
      table.string('name');
      table.string('email').unique();
      // A PHC string (argon2id); never in `Row<'users'>`, never in a select-all result.
      table.string('password').secret();
      table.timestamp('email_verified_at').nullable();
      // The language the account was made in (or chose): mails reach the user in it.
      table.string('locale', 35).nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('users'),
});

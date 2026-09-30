import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.create('users', (table) => {
      table.id();
      table.string('name');
      table.string('email').unique();
      table.boolean('is_admin').default(false);
      table.json('settings').nullable();
      table.decimal('balance', 10, 2).default('0.00');
      table.date('born_on').nullable();
      table.timestamps();
      table.softDeletes();
    }),
  down: (schema) => schema.drop('users'),
});

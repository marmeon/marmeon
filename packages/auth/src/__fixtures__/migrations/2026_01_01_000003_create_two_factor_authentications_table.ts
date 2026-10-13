import { defineMigration } from '@marmeon/database';

// What make:auth writes — here without the foreign key: the package tests keep users in memory.
export default defineMigration({
  up: (schema) =>
    schema.create('two_factor_authentications', (table) => {
      table.id();
      table.bigInteger('user_id').unique();
      table.text('secret').secret();
      table.timestamp('confirmed_at').nullable();
      table.bigInteger('last_used_step').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('two_factor_authentications'),
});

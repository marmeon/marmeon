import { defineMigration } from '@marmeon/database';

// What make:sign-ins-table writes — here without the foreign key: the package tests keep users in memory.
export default defineMigration({
  up: (schema) =>
    schema.create('marmeon_sign_ins', (table) => {
      table.string('id', 22).primary();
      table.bigInteger('user_id');
      table.string('user_agent', 255).nullable();
      table.string('remember_selector', 32).nullable().unique();
      table.timestamp('remember_until').nullable();
      table.timestamp('signed_in_at');
      table.timestamp('last_seen_at');
      table.timestamps();
      table.index('user_id');
    }),
  down: (schema) => schema.drop('marmeon_sign_ins'),
});

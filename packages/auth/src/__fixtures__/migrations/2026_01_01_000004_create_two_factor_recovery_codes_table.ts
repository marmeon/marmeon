import { defineMigration } from '@marmeon/database';

// What make:auth writes — here without the foreign key: the package tests keep users in memory.
export default defineMigration({
  up: (schema) =>
    schema.create('marmeon_two_factor_recovery_codes', (table) => {
      table.id();
      table.bigInteger('user_id');
      table.string('code_hash', 64).secret();
      table.timestamp('used_at').nullable();
      table.timestamps();
      table.unique(['user_id', 'code_hash']);
    }),
  down: (schema) => schema.drop('marmeon_two_factor_recovery_codes'),
});

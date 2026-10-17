import { defineMigration } from '@marmeon/database';

// What make:auth writes — here without the foreign key: the package tests keep users in memory.
export default defineMigration({
  up: (schema) =>
    schema.create('marmeon_remember_tokens', (table) => {
      table.id();
      table.bigInteger('user_id');
      table.string('selector', 32).unique();
      table.string('validator_hash', 64).secret();
      table.string('previous_validator_hash', 64).nullable().secret();
      table.timestamp('rotated_at').nullable();
      table.timestamp('last_used_at').nullable();
      table.timestamp('expires_at');
      table.string('account_fingerprint', 64).nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('marmeon_remember_tokens'),
});

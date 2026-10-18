import { defineMigration } from '@marmeon/database';

// What make:sign-ins-table writes — here without the foreign key: the package tests keep users in memory.
export default defineMigration({
  up: (schema) =>
    schema.create('sign_ins', (table) => {
      table.string('id', 22).primary();
      table.bigInteger('user_id');
      table.string('user_agent', 255).nullable();
      table.string('remember_selector', 32).nullable().secret().unique();
      table.timestamp('remember_until').nullable();
      table.timestamp('signed_in_at');
      table.timestamp('last_seen_at');
      table.timestamps();
      // The remember-me token of the device: the validator only as a SHA-256, the one before it for the grace after a rotation, and the
      // fingerprint of the account state it was issued under.
      table.string('remember_validator_hash', 64).nullable().secret();
      table.string('remember_previous_validator_hash', 64).nullable().secret();
      table.timestamp('remember_rotated_at').nullable();
      table.timestamp('remember_created_at').nullable();
      table.string('remember_fingerprint', 64).nullable();
      table.index('user_id');
    }),
  down: (schema) => schema.drop('sign_ins'),
});

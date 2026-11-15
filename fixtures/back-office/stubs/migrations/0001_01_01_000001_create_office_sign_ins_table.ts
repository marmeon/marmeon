import { defineMigration } from '@marmeon/database';

// The sign-ins of the back office's guard, `office`: the shape of the app's `sign_ins`, named by the guard's prefix. The selector and
// both validators are secret columns.
export default defineMigration({
  up: (schema) =>
    schema.create('office_sign_ins', (table) => {
      table.string('id', 22).primary();
      table.foreignId('user_id').constrained('office_users').cascadeOnDelete();
      table.string('user_agent', 255).nullable();
      table.string('remember_selector', 32).nullable().secret().unique();
      table.timestamp('remember_until').nullable();
      table.timestamp('signed_in_at');
      table.timestamp('last_seen_at');
      table.timestamps();
      table.string('remember_validator_hash', 64).nullable().secret();
      table.string('remember_previous_validator_hash', 64).nullable().secret();
      table.timestamp('remember_rotated_at').nullable();
      table.timestamp('remember_created_at').nullable();
      table.string('remember_fingerprint', 64).nullable();
      table.index('user_id');
    }),
  down: (schema) => schema.drop('office_sign_ins'),
});

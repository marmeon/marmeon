import { defineMigration } from '@marmeon/database';

// "Keep me signed in", one row per device: the selector finds the row, the validator is only stored as a hash.
export default defineMigration({
  up: (schema) =>
    schema.create('remember_tokens', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('selector', 32).unique();
      table.string('validator_hash', 64).secret();
      table.string('previous_validator_hash', 64).nullable().secret();
      table.timestamp('rotated_at').nullable();
      table.timestamp('last_used_at').nullable();
      table.timestamp('expires_at');
      table.timestamps();
    }),
  down: (schema) => schema.drop('remember_tokens'),
});

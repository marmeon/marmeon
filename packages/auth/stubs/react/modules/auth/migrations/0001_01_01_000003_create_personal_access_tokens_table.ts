import { defineMigration } from '@marmeon/database';

// API tokens: only a hash of the secret, found by its unique index; abilities as JSON.
export default defineMigration({
  up: (schema) =>
    schema.create('personal_access_tokens', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('name');
      table.string('token_hash', 64).secret().unique();
      table.json('abilities');
      table.timestamp('last_used_at').nullable();
      table.timestamp('expires_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('personal_access_tokens'),
});

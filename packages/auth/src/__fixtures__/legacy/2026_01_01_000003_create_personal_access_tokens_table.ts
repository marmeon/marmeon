// @marmeon-stub auth 1
import { defineMigration } from '@marmeon/database';

// API tokens: the secret only as SHA-256, abilities as JSON.
export default defineMigration({
  up: (schema) =>
    schema.create('personal_access_tokens', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('name');
      table.string('token_hash', 64).secret();
      table.json('abilities');
      table.timestamp('last_used_at').nullable();
      table.timestamp('expires_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('personal_access_tokens'),
});

import { defineMigration } from '@marmeon/database';

// The tokens table of an app whose keys are UUIDs.
export default defineMigration({
  up: (schema) =>
    schema.create('marmeon_personal_access_tokens', (table) => {
      table.uuidId();
      table.string('user_id');
      table.string('name');
      table.string('token_hash', 64).secret().unique();
      table.json('abilities');
      table.timestamp('last_used_at').nullable();
      table.timestamp('expires_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('marmeon_personal_access_tokens'),
});

import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('personal_access_tokens', (table) => {
      table.id();
      table.bigInteger('user_id');
      table.string('name');
      table.string('token_hash', 64).secret().unique();
      table.json('abilities');
      table.timestamp('last_used_at').nullable();
      table.timestamp('expires_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('personal_access_tokens'),
});

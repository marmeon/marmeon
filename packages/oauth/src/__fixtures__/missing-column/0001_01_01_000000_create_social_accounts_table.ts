import { defineMigration } from '@marmeon/database';

// A table made by hand that lacks `scopes`.
export default defineMigration({
  up: (schema) =>
    schema.create('social_accounts', (table) => {
      table.id();
      table.foreignId('user_id').constrained('users').cascadeOnDelete();
      table.string('provider', 32);
      table.string('provider_id', 255);
      table.text('email').nullable();
      table.text('nickname').nullable();
      table.text('access_token').nullable().secret();
      table.text('refresh_token').nullable().secret();
      table.timestamp('token_expires_at').nullable();
      table.timestamp('last_used_at').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('social_accounts'),
});

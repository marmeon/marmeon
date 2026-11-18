import { defineMigration } from '@marmeon/database';

// The accounts people sign in with at a provider. Two unique indexes carry the rules: (provider, provider_id) says one provider account
// belongs to one user, and (user_id, provider) says one user links one account per provider. The tokens are secret columns, empty
// unless OAUTH_STORE_TOKENS is on, and hold ciphertext only. The e-mail address and nickname are what the provider reported last, as text: a provider's length is no limit of ours, and neither is ever a key.
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
      table.text('scopes').nullable();
      table.timestamp('last_used_at').nullable();
      table.timestamps();
      table.unique(['provider', 'provider_id']);
      table.unique(['user_id', 'provider']);
    }),
  down: (schema) => schema.drop('social_accounts'),
});

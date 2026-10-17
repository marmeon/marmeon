import { defineMigration } from '@marmeon/database';

// The authenticator app of an account (its secret encrypted, bound to the user, unconfirmed until the first code was shown) and the
// recovery codes (the account's, not one factor's: only their hashes are stored, and each works once).
export default defineMigration({
  up: async (schema) => {
    await schema.create('two_factor_authentications', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete().unique();
      table.text('secret').secret();
      table.timestamp('confirmed_at').nullable();
      table.bigInteger('last_used_step').nullable();
      table.timestamps();
    });
    await schema.create('two_factor_recovery_codes', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('code_hash', 64).secret();
      table.timestamp('used_at').nullable();
      table.timestamps();
      table.unique(['user_id', 'code_hash']);
    });
  },
  down: async (schema) => {
    await schema.drop('two_factor_recovery_codes');
    await schema.drop('two_factor_authentications');
  },
});

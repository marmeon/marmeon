import { defineMigration } from '@marmeon/database';

// The authenticator app of an editor (its secret encrypted, bound to the guard and the editor, unconfirmed until the first code was shown) and the
// recovery codes (the editor's, not one factor's: only their hashes are stored, and each works once). The shape of the app's tables, named by the guard's prefix.
export default defineMigration({
  up: (schema) => {
    schema.create('office_two_factor_authentications', (table) => {
      table.id();
      table.foreignId('user_id').constrained('office_users').cascadeOnDelete().unique();
      table.text('secret').secret();
      table.timestamp('confirmed_at').nullable();
      table.bigInteger('last_used_step').nullable();
      table.timestamps();
    });
    schema.create('office_two_factor_recovery_codes', (table) => {
      table.id();
      table.foreignId('user_id').constrained('office_users').cascadeOnDelete();
      table.string('code_hash', 64).secret();
      table.timestamp('used_at').nullable();
      table.timestamps();
      table.unique(['user_id', 'code_hash']);
    });
  },
  down: (schema) => {
    schema.drop('office_two_factor_recovery_codes');
    schema.drop('office_two_factor_authentications');
  },
});

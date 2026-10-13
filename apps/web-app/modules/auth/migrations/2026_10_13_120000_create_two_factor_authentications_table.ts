import { defineMigration } from '@marmeon/database';

// The authenticator app of an account: its secret encrypted (bound to the user), unconfirmed until the first code was shown.
export default defineMigration({
  up: (schema) =>
    schema.create('two_factor_authentications', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete().unique();
      table.text('secret').secret();
      table.timestamp('confirmed_at').nullable();
      table.bigInteger('last_used_step').nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('two_factor_authentications'),
});

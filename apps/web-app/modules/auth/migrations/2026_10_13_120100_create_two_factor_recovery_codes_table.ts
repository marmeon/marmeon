import { defineMigration } from '@marmeon/database';

// Recovery codes belong to the account, not to one factor: only their hashes are stored, and each works once.
export default defineMigration({
  up: (schema) =>
    schema.create('two_factor_recovery_codes', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('code_hash', 64).secret();
      table.timestamp('used_at').nullable();
      table.timestamps();
      table.unique(['user_id', 'code_hash']);
    }),
  down: (schema) => schema.drop('two_factor_recovery_codes'),
});

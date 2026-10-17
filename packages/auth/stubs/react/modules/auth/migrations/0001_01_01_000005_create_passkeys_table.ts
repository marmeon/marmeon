// @marmeon-stub auth 2
import { defineMigration } from '@marmeon/database';

// The passkeys of an account. The public key is public (not secret); `user_handle` is the account's random handle, the same in each of its
// rows and never its id or address; `sign_count` only moves forward (a conditional UPDATE decides).
export default defineMigration({
  up: (schema) =>
    schema.create('passkeys', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('user_handle', 64);
      table.string('credential_id', 1400).unique();
      table.text('public_key');
      table.integer('algorithm');
      table.bigInteger('sign_count');
      table.json('transports');
      table.string('aaguid', 36);
      table.boolean('backup_eligible');
      table.boolean('backed_up');
      table.string('name', 100);
      table.timestamp('last_used_at').nullable();
      table.timestamp('suspended_at').nullable(); // a sign count went backwards: no sign-in until the owner releases it
      table.timestamps();
    }),
  down: (schema) => schema.drop('passkeys'),
});

import { defineMigration } from '@marmeon/database';

// The passkeys of an editor, in the shape of the app's `passkeys`, named by the guard's prefix. The public key is public (not secret); `user_handle` is the
// editor's random handle, the same in each of its rows and never its id or address; `sign_count` only moves forward (a conditional UPDATE decides).
export default defineMigration({
  up: (schema) =>
    schema.create('office_passkeys', (table) => {
      table.id();
      table.foreignId('user_id').constrained('office_users').cascadeOnDelete();
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
      table.timestamp('suspended_at').nullable(); // a sign count went backwards: no sign-in until the editor's passkey is removed
      table.timestamps();
    }),
  down: (schema) => schema.drop('office_passkeys'),
});

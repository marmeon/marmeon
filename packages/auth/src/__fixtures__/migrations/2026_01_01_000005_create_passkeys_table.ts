import { defineMigration } from '@marmeon/database';

// What make:auth writes — here without the foreign key: the package tests keep users in memory.
export default defineMigration({
  up: (schema) =>
    schema.create('passkeys', (table) => {
      table.id();
      table.bigInteger('user_id');
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
      table.timestamps();
      table.index('user_id');
    }),
  down: (schema) => schema.drop('passkeys'),
});

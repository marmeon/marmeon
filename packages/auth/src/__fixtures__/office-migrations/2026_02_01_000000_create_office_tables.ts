import { defineMigration } from '@marmeon/database';

// The tables of a second sign-in circle, named by prefix: the shapes of the auth fixture tables, without the foreign keys.
export default defineMigration({
  up: (schema) => {
    schema.create('office_sign_ins', (table) => {
      table.string('id', 22).primary();
      table.bigInteger('user_id');
      table.string('user_agent', 255).nullable();
      table.string('remember_selector', 32).nullable().secret().unique();
      table.timestamp('remember_until').nullable();
      table.timestamp('signed_in_at');
      table.timestamp('last_seen_at');
      table.timestamps();
      table.string('remember_validator_hash', 64).nullable().secret();
      table.string('remember_previous_validator_hash', 64).nullable().secret();
      table.timestamp('remember_rotated_at').nullable();
      table.timestamp('remember_created_at').nullable();
      table.string('remember_fingerprint', 64).nullable();
      table.index('user_id');
    });
    schema.create('office_password_reset_tokens', (table) => {
      table.string('email').primary();
      table.string('token_hash', 64).secret();
      table.timestamp('created_at');
    });
    schema.create('office_two_factor_authentications', (table) => {
      table.id();
      table.bigInteger('user_id').unique();
      table.text('secret').secret();
      table.timestamp('confirmed_at').nullable();
      table.bigInteger('last_used_step').nullable();
      table.timestamps();
    });
    schema.create('office_two_factor_recovery_codes', (table) => {
      table.id();
      table.bigInteger('user_id');
      table.string('code_hash', 64).secret();
      table.timestamp('used_at').nullable();
      table.timestamps();
      table.unique(['user_id', 'code_hash']);
    });
    schema.create('office_passkeys', (table) => {
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
      table.timestamp('suspended_at').nullable();
      table.timestamps();
      table.index('user_id');
    });
  },
  down: (schema) => {
    for (const name of ['office_passkeys', 'office_two_factor_recovery_codes', 'office_two_factor_authentications', 'office_password_reset_tokens', 'office_sign_ins']) schema.drop(name);
  },
});

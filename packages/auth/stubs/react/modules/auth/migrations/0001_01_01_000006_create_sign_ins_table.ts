import { defineMigration } from '@marmeon/database';

// The sign-ins list: a row per sign-in of a browser, and the authority over it — the session carries only the row's random id, and a
// session whose row is gone ends. A remember-me cookie hangs on the row by its selector, a secret like the cookie it comes from. The user agent is cut to 255 characters; no
// IP address is stored (the `Login` event carries it, for an audit log). `last_seen_at` is written at most every five minutes.
export default defineMigration({
  up: (schema) =>
    schema.create('sign_ins', (table) => {
      table.string('id', 22).primary();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('user_agent', 255).nullable();
      table.string('remember_selector', 32).nullable().secret().unique();
      table.timestamp('remember_until').nullable();
      table.timestamp('signed_in_at');
      table.timestamp('last_seen_at');
      table.timestamps();
      // The remember-me token of the device: the validator only as a SHA-256, the one before it for the grace after a rotation, and the
      // fingerprint of the account state it was issued under.
      table.string('remember_validator_hash', 64).nullable().secret();
      table.string('remember_previous_validator_hash', 64).nullable().secret();
      table.timestamp('remember_rotated_at').nullable();
      table.timestamp('remember_created_at').nullable();
      table.string('remember_fingerprint', 64).nullable();
      table.index('user_id');
    }),
  down: (schema) => schema.drop('sign_ins'),
});

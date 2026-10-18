// @marmeon-stub sign-ins 2
import { defineMigration } from '@marmeon/database';

// The remember-me token of a device moves into the row of its sign-in, so one row says both that the browser is signed in and what
// keeps it so. Only columns are added: the tokens of the `remember_tokens` table are not copied.
export default defineMigration({
  up: (schema) =>
    schema.alter('sign_ins', (table) => {
      table.string('remember_validator_hash', 64).nullable().secret();
      table.string('remember_previous_validator_hash', 64).nullable().secret();
      table.timestamp('remember_rotated_at').nullable();
      table.timestamp('remember_created_at').nullable();
      table.string('remember_fingerprint', 64).nullable();
    }),
  down: (schema) =>
    schema.alter('sign_ins', (table) => {
      table.dropColumn('remember_validator_hash');
      table.dropColumn('remember_previous_validator_hash');
      table.dropColumn('remember_rotated_at');
      table.dropColumn('remember_created_at');
      table.dropColumn('remember_fingerprint');
    }),
});

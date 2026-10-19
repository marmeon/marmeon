import { defineMigration } from '@marmeon/database';

// The remember-me token of a device moves into the row of its sign-in, so one row says both that the browser is signed in and what
// keeps it so. The tokens of the `remember_tokens` table are not copied, and the selector column is made again as a secret (a
// column cannot be marked later), so every row loses the selector it had. Every sign-in ends here: the sessions end with the
// upgrade anyway, and a row that kept a remember time but no token would be listed as kept signed in by a cookie that no longer works.
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await db.deleteFrom('sign_ins').execute();
    });
    schema.alter('sign_ins', (table) => {
      table.dropUnique('sign_ins_remember_selector_unique');
      table.dropColumn('remember_selector');
    });
    schema.alter('sign_ins', (table) => {
      table.string('remember_selector', 32).nullable().secret().unique();
      table.string('remember_validator_hash', 64).nullable().secret();
      table.string('remember_previous_validator_hash', 64).nullable().secret();
      table.timestamp('remember_rotated_at').nullable();
      table.timestamp('remember_created_at').nullable();
      table.string('remember_fingerprint', 64).nullable();
    });
  },
  down: (schema) => {
    schema.alter('sign_ins', (table) => {
      table.dropColumn('remember_validator_hash');
      table.dropColumn('remember_previous_validator_hash');
      table.dropColumn('remember_rotated_at');
      table.dropColumn('remember_created_at');
      table.dropColumn('remember_fingerprint');
      table.dropUnique('sign_ins_remember_selector_unique');
      table.dropColumn('remember_selector');
    });
    schema.alter('sign_ins', (table) => {
      table.string('remember_selector', 32).nullable().unique();
    });
  },
});

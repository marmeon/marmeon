import { defineMigration, sql } from '@marmeon/database';

/**
 * When the account confirmed an address for the first time — set once, never cleared. A change of address
 * with `AUTH_PRIVATE_REGISTRATION=false` empties `email_verified_at` (the new address is unconfirmed), this stays:
 * `auth:prune-unverified` never deletes an account that was confirmed once. Accounts confirmed before this migration count.
 */
export default defineMigration({
  up: async (schema) => {
    await schema.alter('users', (table) => table.timestamp('first_verified_at').nullable());
    await sql`update users set first_verified_at = email_verified_at where email_verified_at is not null`.execute(schema.db);
  },
  down: (schema) => schema.alter('users', (table) => table.dropColumn('first_verified_at')),
});

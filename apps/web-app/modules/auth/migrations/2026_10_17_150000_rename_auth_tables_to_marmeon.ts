// @marmeon-stub auth 2
import { defineMigration, type Schema } from '@marmeon/database';

// The tables of the starter kit's auth module under the names the framework reserves: remember_tokens becomes
// marmeon_remember_tokens, and so on, with their indexes and constraints. The rows stay — passwords, authenticator apps, recovery
// codes, passkeys and reset links keep working — and the columns marked secret stay secret. `users` is the app's own and keeps
// its name. Stop every process of the old release — web, workers, scheduler, cron jobs — before `marmeon migrate`: one that keeps
// running fails on the new names. A table the app does not have (it left passkeys out, say) is skipped.
const TABLES = [
  'remember_tokens',
  'password_reset_tokens',
  'personal_access_tokens',
  'two_factor_authentications',
  'two_factor_recovery_codes',
  'passkeys',
] as const;

async function renameEach(schema: Schema, from: (table: string) => string, to: (table: string) => string): Promise<void> {
  for (const table of TABLES) {
    if (await schema.hasTable(from(table))) await schema.rename(from(table), to(table), { indexes: true });
  }
}

export default defineMigration({
  up: (schema) =>
    renameEach(
      schema,
      (table) => table,
      (table) => `marmeon_${table}`,
    ),
  down: (schema) =>
    renameEach(
      schema,
      (table) => `marmeon_${table}`,
      (table) => table,
    ),
});

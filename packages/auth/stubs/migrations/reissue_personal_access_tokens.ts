// @marmeon-stub auth 3
import { defineMigration } from '@marmeon/database';

// API tokens without the row's id in them, found by the unique hash of their secret. Every token issued before is deleted here:
// its form is gone and no code reads it, so nothing could use it, and a hash nobody can match is only dead weight. Only this
// table is touched. Stop every process of the old release first and run `marmeon migrate` before the new one starts, or the
// tokens it issues in between go too. Afterwards issue new tokens and hand them to everything that used one.
const TABLE = 'marmeon_personal_access_tokens';

export default defineMigration({
  up: async (schema) => {
    // An app that keeps its tokens elsewhere has no such table.
    if (!(await schema.hasTable(TABLE))) return;
    await schema.db.deleteFrom(TABLE).execute();
    await schema.alter(TABLE, (table) => table.unique('token_hash'));
  },
  down: async (schema) => {
    if (await schema.hasTable(TABLE)) await schema.alter(TABLE, (table) => table.dropUnique(`${TABLE}_token_hash_unique`));
  },
});

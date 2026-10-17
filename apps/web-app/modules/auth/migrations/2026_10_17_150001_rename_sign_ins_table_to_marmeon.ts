// @marmeon-stub sign-ins 2
import { defineMigration } from '@marmeon/database';

// The sign-ins' table under the name the framework reserves: sign_ins becomes marmeon_sign_ins, with its indexes and
// constraints. The rows stay. Stop every process of the old release — web, workers, scheduler, cron jobs — before
// `marmeon migrate`: one that keeps running fails on the new name.
export default defineMigration({
  up: (schema) => schema.rename('sign_ins', 'marmeon_sign_ins', { indexes: true }),
  down: (schema) => schema.rename('marmeon_sign_ins', 'sign_ins', { indexes: true }),
});

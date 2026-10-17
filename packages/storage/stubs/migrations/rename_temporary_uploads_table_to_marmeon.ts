// @marmeon-stub storage 2
import { defineMigration } from '@marmeon/database';
import { uploadsTableConnection } from '@marmeon/storage';

// The table of temporary uploads under the name the framework reserves: temporary_uploads becomes marmeon_temporary_uploads,
// with its indexes and constraints. The rows stay — an upload that was used stays used. Stop every process of the old
// release — web, workers, scheduler, cron jobs — before `marmeon migrate`: one that keeps running fails on the new name.
export default defineMigration({
  connection: uploadsTableConnection,
  up: async (schema) => {
    await schema.rename('temporary_uploads', 'marmeon_temporary_uploads', { indexes: true });
  },
  down: async (schema) => {
    await schema.rename('marmeon_temporary_uploads', 'temporary_uploads', { indexes: true });
  },
});

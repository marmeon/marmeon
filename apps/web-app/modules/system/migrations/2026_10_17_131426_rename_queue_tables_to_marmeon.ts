// @marmeon-stub queue 2
import { defineMigration } from '@marmeon/database';
import { queueTablesConnection } from '@marmeon/queue';

// The queue's tables under the names the framework reserves: jobs becomes marmeon_jobs, failed_jobs becomes
// marmeon_failed_jobs, with their indexes and constraints. The rows stay. Stop every process of the old release — web,
// workers, scheduler, cron jobs — before `marmeon migrate`: one that keeps running fails on the new names.
export default defineMigration({
  connection: queueTablesConnection,
  up: async (schema) => {
    await schema.rename('jobs', 'marmeon_jobs', { indexes: true });
    await schema.rename('failed_jobs', 'marmeon_failed_jobs', { indexes: true });
  },
  down: async (schema) => {
    await schema.rename('marmeon_failed_jobs', 'failed_jobs', { indexes: true });
    await schema.rename('marmeon_jobs', 'jobs', { indexes: true });
  },
});

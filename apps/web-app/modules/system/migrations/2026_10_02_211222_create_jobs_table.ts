import { defineMigration } from '@marmeon/database';
import { queueTablesConnection } from '@marmeon/queue';

// The tables of QUEUE_CONNECTION=database (written by `marmeon make:queue-table`): a row per queued job — its record as
// JSON, the attempts so far, when a worker claimed it (null: waiting) and when it may run, all in epoch milliseconds —
// and a row per failed job, with the error (redacted) that ended it. `marmeon queue:prune-failed` empties the second.
export default defineMigration({
  // DB_QUEUE_CONNECTION — failed_jobs goes with it (a QUEUE_FAILED_CONNECTION of its own stops the migration and says what to do).
  connection: queueTablesConnection,
  up: async (schema) => {
    await schema.create('jobs', (table) => {
      table.id();
      table.string('queue');
      table.text('payload');
      table.integer('attempts');
      table.bigInteger('reserved_at').nullable();
      table.bigInteger('available_at');
      table.bigInteger('created_at');
      table.index(['queue', 'reserved_at', 'available_at']);
      // A worker without --queue claims the oldest due job of every queue in one statement — this index serves it.
      table.index(['reserved_at', 'available_at', 'id']);
    });
    await schema.create('failed_jobs', (table) => {
      table.string('uuid', 64).primary();
      table.string('connection');
      table.string('queue');
      table.string('job');
      table.text('payload');
      table.text('exception');
      table.bigInteger('failed_at');
      table.index('failed_at');
    });
  },
  down: async (schema) => {
    await schema.drop('failed_jobs');
    await schema.drop('jobs');
  },
});

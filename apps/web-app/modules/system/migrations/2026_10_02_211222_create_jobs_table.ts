import { defineMigration } from '@bespokecore/database';

// The tables of QUEUE_CONNECTION=database (written by `bespoke make:queue-table`): a row per queued job — its record as
// JSON, the attempts so far, when a worker claimed it (null: waiting) and when it may run, all in epoch milliseconds —
// and a row per failed job, with the error (redacted) that ended it. `bespoke queue:prune-failed` empties the second.
export default defineMigration({
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

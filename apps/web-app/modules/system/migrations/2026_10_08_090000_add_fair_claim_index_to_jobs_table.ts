import { defineMigration } from '@marmeon/database';

// The index the fair claim walks (E199): a worker without --queue takes the oldest due job of every queue in one statement along
// (reserved_at, available_at, id). A jobs table made before Wave 10 gets it here — a migration that ran never runs again
// (docs/deployment.md#the-queue-index-of-an-older-app); make:queue-table writes it into a new table itself.
export default defineMigration({
  up: (schema) => schema.alter('jobs', (table) => table.index(['reserved_at', 'available_at', 'id'])),
  down: (schema) => schema.alter('jobs', (table) => table.dropIndex('jobs_reserved_at_available_at_id_index')),
});

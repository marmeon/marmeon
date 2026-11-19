import { defineMigration } from '../../../index.ts';

// The down() drops a column that a foreign key holds: MySQL refuses that, and the rollback says so right before this down() runs.
export default defineMigration({
  up: (schema) => schema.alter('rb_posts', (table) => void table.foreignId('parent_id').constrained('rb_parents')),
  down: (schema) => schema.alter('rb_posts', (table) => table.dropColumn('parent_id')),
});

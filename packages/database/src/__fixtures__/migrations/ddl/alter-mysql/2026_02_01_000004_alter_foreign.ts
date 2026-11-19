import { defineMigration } from '../../../../index.ts';

// SQLite adds no foreign key to an existing column: only the run on MySQL loads this group (the sibling directory `<group>-mysql`).
export default defineMigration({
  up: (schema) => schema.alter('ddl_keys', (table) => table.foreign('loose_id').constrained('ddl_people').cascadeOnDelete()),
  down: () => {},
});

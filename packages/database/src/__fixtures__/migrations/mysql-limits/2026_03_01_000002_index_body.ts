import { defineMigration } from '../../../index.ts';

// MySQL holds the text() column of the first migration as longtext, which no index covers: a run on MySQL refuses this migration before it sends a statement.
export default defineMigration({
  up: (schema) => {
    schema.alter('limit_notes', (table) => table.index('title'));
    schema.alter('limit_notes', (table) => table.index('body'));
  },
  down: () => {},
});

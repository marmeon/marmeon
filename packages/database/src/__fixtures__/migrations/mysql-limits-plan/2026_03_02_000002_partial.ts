import { defineMigration } from '../../../index.ts';

// MySQL has no partial index: a run on MySQL refuses this migration before it sends a statement, and the one after it never runs.
export default defineMigration({
  up: (schema) => {
    schema.create('lp_b', (table) => table.id());
    schema.alter('lp_a', (table) => {
      table.string('s');
      table.index('s', { name: 'lp_partial', where: { s: 'x' } });
    });
  },
  down: () => {},
});

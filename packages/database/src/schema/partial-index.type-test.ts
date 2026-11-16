// Type guarantees of the condition of a partial index — checked by `tsc` (pnpm build / typecheck), never run.
import { defineMigration } from '../index.ts';

defineMigration({
  up: (schema) =>
    schema.create('pages', (table) => {
      table.id();
      table.string('slug');
      table.string('stage');
      table.unique(['slug', 'stage'], { where: { stage: 'live' } });
      table.index('slug', { name: 'pages_alive', where: { deleted_at: null, rank: 3, featured: true, note: { not: null } } });
      table.index('slug', 'pages_named');
      table.index('slug', { name: 'pages_options' });
      // @ts-expect-error — undefined is no value of a condition
      table.index('slug', { where: { stage: undefined } });
      // @ts-expect-error — only null can be excluded
      table.index('slug', { where: { stage: { not: 'live' } } });
      // @ts-expect-error — a condition is a map of columns, not a string of SQL
      table.index('slug', { where: "stage = 'live'" });
      // @ts-expect-error — a list is no value
      table.unique('slug', { where: { stage: ['live'] } });
      // @ts-expect-error — the options hold a name and a condition only
      table.index('slug', { predicate: { stage: 'live' } });
    }),
});

// Type guarantees of oneOf() — checked by `tsc` (pnpm build / typecheck), never run.
import { defineMigration } from '../index.ts';

defineMigration({
  up: (schema) =>
    schema.create('memberships', (table) => {
      table.id();
      table.string('role').oneOf('admin', 'member').default('member');
      table.string('state').nullable().oneOf('open', 'closed').default(null);
      // @ts-expect-error — the default is one of the values
      table.string('kind').oneOf('a', 'b').default('c');
      // @ts-expect-error — only a string column is held to a list of strings
      table.integer('count').oneOf('1', '2');
      // @ts-expect-error — a value is a string
      table.string('level').oneOf(1, 2);
    }),
});

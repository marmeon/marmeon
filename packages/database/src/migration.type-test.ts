// Type guarantees of the migration's plan — checked by `tsc` (pnpm build / typecheck), never run.
import { defineMigration } from './index.ts';

defineMigration({
  up: (schema) => {
    schema.create('reports', (table) => table.id());
    schema.data(async (db) => {
      await db.updateTable('reports').set({ id: 1 }).execute();
    });
  },
  down: (schema) => schema.drop('reports'),
});

defineMigration({
  // @ts-expect-error — `up` builds a plan and runs nothing: it cannot be async
  up: async (schema) => {
    schema.create('reports', (table) => table.id());
  },
});

defineMigration({
  up: (schema) => schema.drop('reports'),
  // @ts-expect-error — nor can `down`
  down: async (schema) => {
    schema.drop('reports');
  },
});

defineMigration({
  // @ts-expect-error — a function that hands back a promise is no better than an async one
  up: (schema) => Promise.resolve(schema.drop('reports')),
});

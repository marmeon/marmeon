import { defineMigration, sql } from '../../../index.ts';

// Changes the rows, then runs the statement the test names: a statement that commits would keep the change.
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await db.updateTable('ledger').set({ amount: 99 }).execute();
      const given = (globalThis as { guardedStatement?: string | (() => ReturnType<typeof sql>) | ((sql: unknown, db: unknown) => PromiseLike<unknown>) }).guardedStatement;
      if (typeof given === 'function' && given.length === 2) await (given as (sql: unknown, db: unknown) => PromiseLike<unknown>)(sql, db);
      else await (typeof given === 'function' ? (given as () => ReturnType<typeof sql>)() : sql.raw(given ?? 'select 1')).execute(db);
    });
  },
});

// Type guarantees of the query builder's names — checked by `tsc` (pnpm build / typecheck), never run.
import type { Kysely, Transaction as KyselyTransaction } from 'kysely';
import type { Connection, Generated, NewRow, NewRowOf, Row, RowOf, RowUpdate, RowUpdateOf, SelectQuery, Transaction } from './index.ts';
// @ts-expect-error — the builder's own names are not exported
import type { Insertable, Selectable, Updateable } from './index.ts';
// @ts-expect-error — `Kysely` is not exported either; `Connection` is the same type
import type { Kysely as ExportedKysely } from './index.ts';

interface Users {
  id: Generated<number>;
  name: string;
  email: string | null;
}
interface Tables {
  users: Users;
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assert<T extends true>(): T | undefined {
  return undefined;
}

export function builderTypes(db: Connection<Tables>, trx: Transaction<Tables>, select: SelectQuery<Tables, 'users', { id: number }>) {
  assert<Equal<RowOf<Users>, { id: number; name: string; email: string | null }>>();
  assert<Equal<Connection<Tables>, Kysely<Tables>>>();
  assert<Equal<Transaction<Tables>, KyselyTransaction<Tables>>>();
  assert<Equal<Awaited<ReturnType<typeof select.executeTakeFirst>>, { id: number } | undefined>>();

  const added: NewRowOf<Users> = { name: 'Ada' };
  const withId: NewRowOf<Users> = { id: 1, name: 'Ada', email: null };
  const change: RowUpdateOf<Users> = { email: 'ada@example.com' };
  // @ts-expect-error — a column without a default is required
  const missing: NewRowOf<Users> = { email: null };
  // @ts-expect-error — a generated id is a number
  const wrong: NewRowOf<Users> = { id: 'one', name: 'Ada' };

  void db.selectFrom('users').selectAll().execute();
  void trx.updateTable('users').set(change);
  return [added, withId, missing, wrong];
}

// The table-name forms take a name from the app's `Tables`; none is declared in this package, so no name fits.
// @ts-expect-error — 'nope' is not a table
export type NoRow = Row<'nope'>;
// @ts-expect-error — 'nope' is not a table
export type NoNewRow = NewRow<'nope'>;
// @ts-expect-error — 'nope' is not a table
export type NoRowUpdate = RowUpdate<'nope'>;
// @ts-expect-error — a table type is `RowOf`'s argument, not `Row`'s
export type NoTableType = Row<Users>;

export type Unused = [Insertable<Users>, Selectable<Users>, Updateable<Users>, ExportedKysely<Tables>];

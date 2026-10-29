/**
 * Type guarantees of `useTable().run()` / `runBulk()` — checked by `tsc`, never run: an untyped table (`AnyTableData`) takes them
 * without an input, and one whose action has an input schema requires it.
 */
import type { AnyTableData, TableData } from '@marmeon/table/client';
import { useTable, type Table } from './table.ts';

export function untyped(data: AnyTableData) {
  const table = useTable(data);
  void table.run('anything', table.rows[0]!);
  void table.runBulk('anything');
}

type WithInput = TableData<{ id: number }, 'name', never, 'setRole', 'setRole', never, 'name', { setRole: { role: string } }, { setRole: { role: string } }>;

export function typed(table: Table<WithInput>) {
  void table.run('setRole', table.rows[0]!, { input: { role: 'admin' } });
  void table.runBulk('setRole', { input: { role: 'admin' } });
  // @ts-expect-error — the action takes an input
  void table.run('setRole', table.rows[0]!);
  // @ts-expect-error — the bulk action takes an input
  void table.runBulk('setRole');
}

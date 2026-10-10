// --- Type checks: useTable is typed by the table's props -------------------------------------------------------------
import type { PageProps } from '@marmeon/http';
import { useTable } from '@marmeon/react/table';
import { describe, expectTypeOf, it } from 'vitest';
import type { ListMembersController } from './controllers/ListMembersController.ts';

type Members = PageProps<ListMembersController>['members'];

export function Typed({ members }: { members: Members }) {
  const table = useTable(members);
  const [row] = table.rows;

  table.sort('joined');
  table.sort('name', 'desc');
  table.sort('email'); // sortable for those who see it
  // @ts-expect-error — the database column, not the table's alias
  table.sort('created_at');
  // @ts-expect-error — the key is no column of the table
  table.sort('id');
  table.filter('locale', 'de');
  // @ts-expect-error — no such filter
  table.filter('role', 'admin');
  table.filterBy({ locale: null, joined: '2026-01-01..' });
  // @ts-expect-error — no such filter
  table.filterBy({ loclae: 'de' });
  if (row) {
    void table.run('removeLinks', row);
    // @ts-expect-error — no such row action
    void table.run('remove', row);
    // @ts-expect-error — a row of another table
    void table.run('removeLinks', { id: 1 });
    expectTypeOf(row.name).toEqualTypeOf<string>();
    expectTypeOf(row.email).toEqualTypeOf<string | undefined>();
    expectTypeOf(row.can.removeLinks).toEqualTypeOf<boolean>();
    table.can('removeLinks', row);
  }
  void table.runBulk('removeLinks');
  // @ts-expect-error — no such bulk action
  void table.runBulk('deleteAll');
  table.exportUrl('csv');
  // @ts-expect-error — no such export
  table.exportUrl('xlsx');
  useTable(members, {
    labels: {
      column: (name) => {
        expectTypeOf(name).toEqualTypeOf<'name' | 'email' | 'joined' | 'links'>();
        return name;
      },
      row: (member) => member.name,
      // @ts-expect-error — a row is no string
      select: (member: { name: string }) => member.name,
    },
  });
  return null;
}

describe('useTable — typed by the props', () => {
  it('names the columns, the sortable ones and the row', () => {
    type Table = ReturnType<typeof useTable<Members>>;
    expectTypeOf<Parameters<Table['sort']>[0]>().toEqualTypeOf<'name' | 'email' | 'joined' | 'links'>();
    expectTypeOf<Parameters<Table['filter']>[0]>().toEqualTypeOf<'joined' | 'locale'>();
    expectTypeOf<Parameters<Table['exportUrl']>[0]>().toEqualTypeOf<'csv'>();
  });
});

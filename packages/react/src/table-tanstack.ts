/**
 * `@marmeon/react/table-tanstack`: a bridge from `useTable` to TanStack Table v9 (`@tanstack/react-table`, an optional peer). The
 * server still sorts, filters and pages — TanStack runs in manual mode, and its sorting, pagination and row selection go back
 * through `useTable`. Types only: TanStack is in a bundle only where the app imports it. See docs/tables.md#tanstack-table.
 */
import type { ColumnDef, OnChangeFn, PaginationState, RowSelectionState, SortingState, TableFeatures, TableOptions, Updater } from '@tanstack/react-table';
import type { AnyTableData, RowOf, SortableOf } from '@marmeon/table/client';
import type { Table } from './table.ts';

export interface ToTanStackOptions<F extends TableFeatures, T extends AnyTableData> {
  /** TanStack's features — `tableFeatures({ rowSortingFeature, rowPaginationFeature, rowSelectionFeature })`, at module scope. */
  readonly features: F;
  /** Columns of your own (cells, sizes) — default: one per visible column, its header the column's label. */
  readonly columns?: readonly ColumnDef<F, RowOf<T>>[];
}

const apply = <S>(updater: Updater<S>, current: S): S => (typeof updater === 'function' ? (updater as (old: S) => S)(current) : updater);

/**
 * The options of TanStack's `useTable` for a `useTable` table: its rows (by key), columns, and the state the server owns — sorting,
 * pagination — plus the entry's selection, each with the handler that sends it back. Manual sorting, filtering and pagination: TanStack
 * never sorts or pages rows itself (it sees one page). One column sorts at a time, and a sort is never removed (the table has a default).
 */
export function toTanStack<F extends TableFeatures, T extends AnyTableData>(table: Table<T>, { features, columns }: ToTanStackOptions<F, T>): TableOptions<F, RowOf<T>> {
  const { data } = table;
  const sorting: SortingState = data.sort ? [{ id: data.sort.column, desc: data.sort.direction === 'desc' }] : [];
  const pagination: PaginationState = data.page.type === 'offset' ? { pageIndex: data.page.page - 1, pageSize: data.page.perPage } : { pageIndex: 0, pageSize: data.page.perPage };
  const rowSelection: RowSelectionState = Object.fromEntries(data.rows.filter((row) => table.isSelected(row)).map((row) => [String(table.key(row)), true] as const));
  const onSortingChange: OnChangeFn<SortingState> = (updater) => {
    const [next] = apply(updater, sorting);
    if (next) table.sort(next.id as SortableOf<T>, next.desc ? 'desc' : 'asc');
  };
  const onPaginationChange: OnChangeFn<PaginationState> = (updater) => {
    const next = apply(updater, pagination);
    if (next.pageSize !== pagination.pageSize) table.perPage(next.pageSize);
    else if (next.pageIndex !== pagination.pageIndex) table.goTo(next.pageIndex + 1);
  };
  const onRowSelectionChange: OnChangeFn<RowSelectionState> = (updater) => {
    const next = apply(updater, rowSelection);
    for (const row of data.rows) {
      const selected = next[String(table.key(row))] === true;
      if (selected !== table.isSelected(row)) table.select(row, selected);
    }
  };
  const options = {
    features,
    data: data.rows as readonly RowOf<T>[],
    columns:
      columns ??
      table.columns.map((column) => ({
        id: column.name,
        accessorFn: (row: RowOf<T>) => (row as Record<string, unknown>)[column.name],
        header: column.label,
        enableSorting: column.sortable,
      })),
    getRowId: (row: RowOf<T>) => String(table.key(row)),
    state: { sorting, pagination, rowSelection },
    onSortingChange,
    onPaginationChange,
    onRowSelectionChange,
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    enableMultiSort: false,
    enableSortingRemoval: false,
    ...(data.page.type === 'offset' ? { rowCount: data.page.total } : { pageCount: -1 }),
  };
  return options as unknown as TableOptions<F, RowOf<T>>;
}

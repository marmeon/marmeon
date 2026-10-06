/**
 * `@bespokecore/react/table` — the headless table of `@bespokecore/table` for React (W9 step 6, E183): `useTable(props.members)` gives a
 * component what it needs to render a server-driven table its own way — the visible columns with their header attributes, the rows,
 * sorting, filters, search and pages (visits of the page's URL), the selection, row and bulk actions, exports and the text of a live
 * region. It renders nothing itself.
 *
 * A subpath of its own with `@bespokecore/table` as an optional peer: an app gets it only when it installs the table package and
 * imports this module — `@bespokecore/react` itself never imports it, so discovery never pulls the table into a React app that has
 * no tables (E76, the W5.9 lesson with i18n). Its code is in the bundle of the page that imports it, nowhere else.
 */
import { exportUrl, keyOf, sortUrl, tableStatus, TableController } from '@bespokecore/table/client';
import type {
  ActionOf,
  AnyTableData,
  TableStatusInfo,
  BulkOf,
  ColumnOf,
  ExportOf,
  FilterOf,
  RowOf,
  SortableOf,
  SortDirection,
  TableColumn,
  TableRunOptions,
  TableRunOutcome,
} from '@bespokecore/table/client';
import type { SelectionKey } from '@bespokecore/http/client';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type MouseEvent } from 'react';
import { RegionOwnerContext, useRouterContext } from './app.tsx';

export type { ActionOf, BulkOf, ColumnOf, ExportOf, FilterOf, RowOf, SortableOf, TableRunOptions, TableRunOutcome, TableStatusInfo } from '@bespokecore/table/client';

/**
 * The words of a table — English by default, the app's through its translations (E38): `labels: { column: (name) => t(`column.${name}`),
 * status: (info) => t('status', info), … }`.
 */
export interface TableLabels<T extends AnyTableData> {
  /** A column's label — default: the definition's `.label()`, else its name. */
  column?(name: ColumnOf<T>): string;
  /** What names a row in the names of its checkbox and its buttons — default: its key. */
  row?(row: RowOf<T>): string;
  /** The live region's text after a change of the list — default "42 rows, sorted by joined (descending), page 2 of 5". */
  status?(info: TableStatusInfo): string;
  /** A row's checkbox — default "Select Ada Lovelace". */
  select?(row: string): string;
  /** The checkbox that selects the page — default "Select every row on this page". */
  selectPage?(): string;
  /**
   * A row action's button name — default "removeLinks: Ada Lovelace". Start it with the button's visible text ("Remove links: Ada
   * Lovelace"), so a voice user can say what they see (WCAG 2.5.3, label in name).
   */
  action?(action: ActionOf<T>, row: string): string;
  /** What an action defined with `.confirm()` asks — default 'Run "removeLinks" for 3 rows?'. */
  confirm?(action: ActionOf<T> | BulkOf<T>, rows: number): string;
}

export interface UseTableOptions<T extends AnyTableData> {
  labels?: TableLabels<T>;
  /** The page prop the table is — default: found on the page (the same object, or a table of the same name). */
  prop?: string;
  /** Wait this long (ms) after the last keystroke before searching (default 300). */
  searchDebounce?: number;
}

/** The attributes of a column's `<th>`: `aria-sort` only on the one the table is sorted by (WAI-ARIA APG) — never `none`. */
export interface HeaderProps {
  readonly scope: 'col';
  readonly 'aria-sort'?: 'ascending' | 'descending';
}

/** A visible column as a component renders it. */
export interface TableColumnView<T extends AnyTableData> extends Omit<TableColumn<ColumnOf<T>>, 'label'> {
  /** What its heading says ({@link TableLabels.column}). */
  readonly label: string;
  readonly headerProps: HeaderProps;
  /** The page sorted by it (toggled) — a link that works without JavaScript; undefined when it does not sort. */
  readonly sortUrl: string | undefined;
  /**
   * A link to {@link sortUrl} that sorts in place (a visit of the table's prop only) on a plain click — `<a {...column.sortLinkProps}>`:
   * without JavaScript, or opened in a new tab, it is the link.
   */
  readonly sortLinkProps: { readonly href: string; onClick(event: MouseEvent<HTMLAnchorElement>): void } | undefined;
  /** Sorts by it (toggled) — for a `<button>` in the `<th>`, named by its label. */
  toggleSort(): void;
}

/** A checkbox's attributes — spread them on an `<input>`. */
export interface CheckboxProps {
  readonly type: 'checkbox';
  readonly checked: boolean;
  readonly 'aria-label': string;
  onChange(event: ChangeEvent<HTMLInputElement>): void;
  /** Sets `indeterminate` (the page checkbox: some rows selected) — no attribute can. */
  readonly ref?: (input: HTMLInputElement | null) => void;
}

/** What `useTable` gives a component. */
export interface Table<T extends AnyTableData> {
  /** The props, as they came. */
  readonly data: T;
  /** The visible columns — in the definition's order. */
  readonly columns: readonly TableColumnView<T>[];
  readonly rows: T['rows'];
  /** A row's key (what actions send). */
  key(row: RowOf<T>): SelectionKey;
  /** What names a row ({@link TableLabels.row}). */
  label(row: RowOf<T>): string;

  /** Sorts by a column's name in the props — toggled without a direction. A visit of the page's URL (`?sort=`), back to page 1. */
  sort(column: SortableOf<T>, direction?: SortDirection): void;
  readonly filters: T['filters'];
  /** `null` takes the filter off. Back to page 1. */
  filter(name: FilterOf<T>, value: string | null): void;
  /** Several filters in one visit (a form's "Apply"). */
  filterBy(values: { readonly [N in FilterOf<T>]?: string | null }): void;
  /** The search, or null when no visible column is searchable. */
  readonly search: T['search'];
  /** Searches after a pause in typing; one history entry for it. */
  setSearch(value: string): void;
  readonly page: T['page'];
  goTo(page: number): void;
  /** The next page of a table paged by cursor. */
  next(): void;
  perPage(size: number): void;

  /** The keys selected (empty while every matching row is). */
  readonly selected: readonly SelectionKey[];
  /** Every matching row is selected — a bulk action sends the table's state, not keys. */
  readonly matching: boolean;
  readonly selectedCount: number;
  /** Every row on this page is selected. */
  readonly allSelected: boolean;
  isSelected(row: RowOf<T>): boolean;
  select(row: RowOf<T>, selected?: boolean): void;
  toggle(row: RowOf<T>): void;
  /** Every row on this page. */
  selectAll(selected?: boolean): void;
  /** Every row that matches the table's state — not only those on screen. */
  selectMatching(): void;
  clearSelection(): void;
  /** A row's checkbox, named after the row. */
  checkboxProps(row: RowOf<T>): CheckboxProps;
  /** The page's checkbox (checked: every row on it, indeterminate: some). */
  pageCheckboxProps(): CheckboxProps;

  readonly actions: T['actions'];
  readonly bulk: T['bulk'];
  readonly exports: T['exports'];
  /** Whether row action `action` is offered for `row` (its policy said yes). */
  can(action: ActionOf<T>, row: RowOf<T>): boolean;
  /** Runs a row action; then the table reloads (replacing what it showed). */
  run(action: ActionOf<T>, row: RowOf<T>, options?: TableRunOptions): Promise<TableRunOutcome>;
  /** Runs a bulk action for what is selected; then the selection is cleared and the table reloads. */
  runBulk(name: BulkOf<T>, options?: TableRunOptions): Promise<TableRunOutcome>;
  /** The name of a row action's button for `row` ({@link TableLabels.action}). */
  actionLabel(action: ActionOf<T>, row: RowOf<T>): string;
  /** An action of this table is under way. */
  readonly pending: boolean;
  /** An export's URL — with the table's sort, search and filters. A download (`<a href download>`), not a visit. */
  exportUrl(name: ExportOf<T>): string;

  /** The live region's text ({@link TableLabels.status}). */
  readonly status: string;
  /** The live region's attributes: `<p {...table.statusProps}>{table.status}</p>`. */
  readonly statusProps: { readonly role: 'status'; readonly 'aria-live': 'polite'; readonly 'aria-atomic': true };
}

const STATUS_PROPS = { role: 'status', 'aria-live': 'polite', 'aria-atomic': true } as const;
const noSubscription = () => () => {};

/**
 * A server-driven table (`@bespokecore/table`), headless — typed by its props (`TableProps<typeof MembersTable>`): only its sortable
 * columns sort, only its filters filter, only its actions run.
 *
 * ```tsx
 * const table = useTable(members, { labels: { column: (name) => t(`column.${name}`) } });
 * <table>
 *   <caption>{t('caption')}</caption>
 *   <thead><tr>{table.columns.map((column) => (
 *     <th key={column.name} {...column.headerProps}>
 *       {column.sortUrl ? <Link href={column.sortUrl} preserveScroll>{column.label}</Link> : column.label}
 *     </th>))}</tr></thead>
 *   …
 * </table>
 * <p {...table.statusProps}>{table.status}</p>
 * ```
 *
 * Sorting, filters, search and pages are visits of the page's URL (query state, E55) — the server parses them again, strictly; the
 * selection lives with the history entry in memory (a sort, a filter or a page starts with none, Back brings it back; a sign-out
 * empties it); an action is an action request (E59), after which the table's prop is reloaded and replaces what it showed.
 */
export function useTable<T extends AnyTableData>(data: T, options: UseTableOptions<T> = {}): Table<T> {
  const router = useRouterContext();
  const navigator = router.navigator();
  const entry = useContext(RegionOwnerContext)?.entry;
  const latest = useRef(options);
  latest.current = options;
  const made = useRef<TableController<T> | null>(null);
  // In the browser, once the page has its history entry: before that (and on the server) nothing is selected.
  if (navigator && entry !== undefined && !made.current) {
    made.current = new TableController(navigator, data, { ...(options.prop !== undefined ? { prop: options.prop } : {}), entry, ...(options.searchDebounce !== undefined ? { searchDebounce: options.searchDebounce } : {}) });
  }
  const controller = made.current;
  controller?.update(data, entry === undefined ? {} : { entry });
  if (controller) controller.confirmText = (action, rows) => latest.current.labels?.confirm?.(action as ActionOf<T>, rows) ?? `Run "${action}" for ${rows} ${rows === 1 ? 'row' : 'rows'}?`;

  // The selection of the entry on screen: re-rendered when it changes (another entry, another selection).
  const subscribe = useCallback((listener: () => void) => (controller ? controller.selection.subscribe(listener) : noSubscription()), [controller, entry]);
  const version = useSyncExternalStore(subscribe, () => controller?.selection.version ?? 0, () => 0);
  const [running, setRunning] = useState(0);

  useEffect(() => {
    // After the render: rows that are gone (an action, a reload) are no longer selected.
    controller?.prune();
  }, [controller, data]);
  useEffect(() => () => made.current?.dispose(), []);

  const page = router.page;
  return useMemo(() => {
    const labels = options.labels ?? {};
    const browser = (): TableController<T> => {
      if (!controller) {
        throw new Error(
          process.env.NODE_ENV !== 'production' ? `[bespoke:R18] useTable(${data.name}): it changes something only in the browser — not while rendering on the server.` : `[bespoke:R18] ${data.name}`,
        );
      }
      return controller;
    };
    const rowLabel = (row: RowOf<T>) => labels.row?.(row) ?? String(keyOf(data, row));
    const columnLabel = (column: TableColumn) => labels.column?.(column.name as ColumnOf<T>) ?? column.label ?? column.name;
    const selection = controller?.selection;
    const isSelected = (row: RowOf<T>) => selection?.has(keyOf(data, row)) ?? false;
    const keys = data.rows.map((row) => keyOf(data, row));
    const allSelected = keys.length > 0 && keys.every((key) => selection?.has(key) ?? false);
    const someSelected = !allSelected && keys.some((key) => selection?.has(key) ?? false);
    const selectedCount = controller?.selectedCount ?? 0;
    const sorted = data.sort && data.columns.find((column) => column.name === data.sort!.column);
    const info: TableStatusInfo = {
      total: data.page.type === 'offset' ? data.page.total : null,
      shown: data.rows.length,
      sort: sorted ? { column: sorted.name, label: columnLabel(sorted), direction: data.sort!.direction } : null,
      page: data.page.type === 'offset' && data.page.lastPage > 1 ? { page: data.page.page, lastPage: data.page.lastPage } : null,
    };
    const table: Table<T> = {
      data,
      columns: data.columns.map((column) => ({
        ...column,
        label: columnLabel(column),
        // aria-sort only where the table is sorted — never "none" on the others (WAI-ARIA APG, sortable table).
        headerProps: column.sort === null ? { scope: 'col' } : { scope: 'col', 'aria-sort': column.sort === 'asc' ? 'ascending' : 'descending' },
        sortUrl: column.sortable ? sortUrl(data, column.name as SortableOf<T>, page) : undefined,
        sortLinkProps: column.sortable
          ? {
              href: sortUrl(data, column.name as SortableOf<T>, page),
              onClick: (event: MouseEvent<HTMLAnchorElement>) => {
                // A click the browser should follow itself (a new tab, a download): the link.
                if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                browser().sort(column.name as SortableOf<T>);
              },
            }
          : undefined,
        toggleSort: () => browser().sort(column.name as SortableOf<T>),
      })),
      rows: data.rows,
      key: (row) => keyOf(data, row),
      label: rowLabel,
      sort: (column, direction) => browser().sort(column, direction),
      filters: data.filters,
      filter: (name, value) => browser().filter(name, value),
      filterBy: (values) => browser().filterBy(values),
      search: data.search,
      setSearch: (value) => browser().search(value),
      page: data.page,
      goTo: (number) => browser().goTo(number),
      next: () => browser().next(),
      perPage: (size) => browser().perPage(size),
      selected: selection?.keys ?? [],
      matching: selection?.matching ?? false,
      selectedCount,
      allSelected,
      isSelected,
      select: (row, selected = true) => browser().select(row, selected),
      toggle: (row) => browser().toggle(row),
      selectAll: (selected = true) => browser().selectAll(selected),
      selectMatching: () => browser().selectMatching(),
      clearSelection: () => browser().clearSelection(),
      checkboxProps: (row) => ({
        type: 'checkbox',
        checked: isSelected(row),
        'aria-label': labels.select?.(rowLabel(row)) ?? `Select ${rowLabel(row)}`,
        onChange: (event) => browser().select(row, event.currentTarget.checked),
      }),
      pageCheckboxProps: () => ({
        type: 'checkbox',
        checked: allSelected || (selection?.matching ?? false),
        'aria-label': labels.selectPage?.() ?? 'Select every row on this page',
        onChange: (event) => browser().selectAll(event.currentTarget.checked),
        ref: (input) => {
          if (input) input.indeterminate = someSelected;
        },
      }),
      actions: data.actions,
      bulk: data.bulk,
      exports: data.exports,
      can: (action, row) => data.actions.some((entry) => entry.name === action) && (row.can as Record<string, boolean>)[action] === true,
      run: (action, row, runOptions) => track(browser().run(action, row, runOptions)),
      runBulk: (name, runOptions) => track(browser().runBulk(name, runOptions)),
      actionLabel: (action, row) => labels.action?.(action, rowLabel(row)) ?? `${action}: ${rowLabel(row)}`,
      pending: running > 0,
      exportUrl: (name) => exportUrl(data, name),
      status: labels.status?.(info) ?? tableStatus(info),
      statusProps: STATUS_PROPS,
    };
    return table;

    async function track(run: Promise<TableRunOutcome>): Promise<TableRunOutcome> {
      setRunning((count) => count + 1);
      try {
        return await run;
      } finally {
        setRunning((count) => count - 1);
      }
    }
    // `version` changes with the selection: what it shows is read again.
  }, [data, controller, version, running, page, options.labels]);
}

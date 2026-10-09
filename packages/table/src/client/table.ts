/**
 * The headless table (W9 step 6, E183), UI-free: what a table's props let the user do in the browser — sort, filter, search and page
 * through the page's URL (query state, E55: the server parses it again, strictly), select rows (a slot of the history entry, emptied
 * with it and with the document), run row and bulk actions (the actions feature, E59: an action request, then the table's prop
 * reloaded — a revalidation, so it **replaces** what the page had, W9 step 3) and download an export. Adapters render it: React's
 * `useTable` (`@marmeon/react/table`), a plain-DOM one in this package's tests.
 *
 * Everything it sends comes from the props: a sort is a column's alias (`column.name`), a filter's key is the one the props name
 * (`filter[role]`, with the table's prefix), an action goes to the URL the props carry — the browser never names a database column,
 * and asking for anything the props do not offer is a programming error (thrown before a request goes out).
 */
import { pageQuery, queryState, queryUrl, selection, type ActionOutcome, type Confirm, type Navigator, type QueryState, type Selection, type SelectionKey } from '@marmeon/http/client';
import type { PageObject } from '@marmeon/http/page';
import { sortValue, type SortDirection, type TableActionResult, type TableData } from './index.ts';

/** Any table's props. */
// oxlint-disable-next-line typescript/no-explicit-any -- the type parameters of the props, whatever they are
export type AnyTableData = TableData<any, string, string, string, string, string, string>;

/** A row of table `T`, with its `can`. */
export type RowOf<T extends AnyTableData> = T['rows'][number];
/** The names of `T`'s columns (the visible ones — a hidden column is in no prop). */
export type ColumnOf<T extends AnyTableData> = T['columns'][number]['name'];
/** The names of `T`'s sortable columns. */
export type SortableOf<T extends AnyTableData> = T extends TableData<infer _R, infer _C, infer _F, infer _A, infer _B, infer _E, infer S> ? S : string;
export type FilterOf<T extends AnyTableData> = T['filters'][number]['name'];
export type ActionOf<T extends AnyTableData> = T['actions'][number]['name'];
export type BulkOf<T extends AnyTableData> = T['bulk'][number]['name'];
export type ExportOf<T extends AnyTableData> = T['exports'][number]['name'];

/** How a row or bulk action ended — an action's outcome (E59), its data what the table's endpoint answers. */
export type TableRunOutcome =
  | { readonly ok: true; readonly kind: 'data'; readonly status: number; readonly data: TableActionResult }
  | Exclude<ActionOutcome, { readonly ok: true; readonly kind: 'data' }>;

/** What one run of an action does besides sending. */
export interface TableRunOptions {
  /** Ask first (E64) — for an action defined with `.confirm()` the table asks anyway, with this text (default: {@link TableController.confirmText}). */
  confirm?: Confirm;
  /** Aborts the run (it ends `cancelled`). */
  signal?: AbortSignal;
}

export interface TableControllerOptions {
  /** The page prop the table is — what a run reloads (`only`). Default: found on the page by name; without one the whole page reloads. */
  prop?: string;
  /** The history entry whose selection it is — a layer's (its `entry`), default the page's. */
  entry?: string;
  /** Wait this long (ms) after the last keystroke before searching. Default 300. */
  searchDebounce?: number;
}

/**
 * Thrown for anything the props do not offer — in production a code and the table's name (docs/errors.md#error-codes):
 * call it as `refuse('[marmeon:C9]', name, (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && …)` (E201: positive, so staging gets the code only), so a production build drops the explanation (E80).
 */
function refuse(code: `[marmeon:${string}]`, table: string, explanation: string | false): never {
  throw new Error(`${code} ${explanation || table}`);
}

const list = (names: readonly string[]) => (names.length > 0 ? names.join(', ') : 'nothing');

/**
 * The page prop that holds table `data`: the same object, or — after an optimistic patch copied the props — the table of the same name.
 */
export function propOf(page: Pick<PageObject, 'props'>, data: Pick<AnyTableData, 'name' | 'columns'>): string | undefined {
  const entries = Object.entries(page.props);
  return (
    entries.find(([, value]) => value === data)?.[0] ??
    entries.find(([, value]) => typeof value === 'object' && value !== null && (value as AnyTableData).name === data.name && Array.isArray((value as AnyTableData).columns))?.[0]
  );
}

/** A row's key: the property the props name (`key`). */
export function keyOf(data: Pick<AnyTableData, 'key'>, row: object): SelectionKey {
  return (row as Record<string, SelectionKey>)[data.key]!;
}

/** What the live region says after a change of the list — the numbers, for an app's own words. */
export interface TableStatusInfo {
  /** Every row that matches (pages by number), or null (pages by cursor: unknown). */
  readonly total: number | null;
  /** The rows on this page. */
  readonly shown: number;
  /** The column it is sorted by — its label — and how. */
  readonly sort: { readonly column: string; readonly label: string; readonly direction: SortDirection } | null;
  /** The page, when there is more than one by number — a page of the same size and sort would otherwise say the same. */
  readonly page: { readonly page: number; readonly lastPage: number } | null;
}

/**
 * The live region's text after a change of the list (English — an adapter passes the app's words): "42 rows, sorted by Joined
 * (descending), page 2 of 5" — "10 rows shown" for a table paged by cursor. Not the selection: a checkbox says its own state.
 */
export function tableStatus(info: TableStatusInfo): string {
  if (info.total === null) return `${info.shown} ${info.shown === 1 ? 'row' : 'rows'} shown`;
  let text = `${info.total} ${info.total === 1 ? 'row' : 'rows'}`;
  if (info.sort && info.total > 0) text += `, sorted by ${info.sort.label} (${info.sort.direction === 'asc' ? 'ascending' : 'descending'})`;
  if (info.page) text += `, page ${info.page.page} of ${info.page.lastPage}`;
  return text;
}

/**
 * One table on screen, in the browser. Make one per table and adapter component, give it the table's props after every render
 * (`update`) and `dispose()` it when the component goes. (On the server an adapter renders from the props alone: nothing is selected.)
 */
export class TableController<T extends AnyTableData = AnyTableData> {
  readonly #navigator: Navigator;
  #options: TableControllerOptions;
  #data: T;
  #query: QueryState | undefined;

  constructor(navigator: Navigator, data: T, options: TableControllerOptions = {}) {
    this.#navigator = navigator;
    this.#data = data;
    this.#options = options;
  }

  get data(): T {
    return this.#data;
  }

  /**
   * The table's props after a render — and the history entry it shows in, when an adapter knows it (a sort pushed a new one). Changes
   * nothing else: call {@link prune} once the render is done.
   */
  update(data: T, options: Pick<TableControllerOptions, 'entry'> = {}): void {
    this.#data = data;
    if (options.entry !== undefined) this.#options = { ...this.#options, entry: options.entry };
  }

  /** Rows that are gone from the props (an action, a reload) are no longer selected. */
  prune(): void {
    const data = this.#data;
    this.selection.retain(data.rows.map((row) => keyOf(data, row)));
  }

  /**
   * What is selected — in the slot of the history entry on screen (the core empties it with the entry and with the document): another
   * entry (a sort, a filter, another page) has its own.
   */
  get selection(): Selection {
    return this.#navigator.use(selection).of(this.#data.name, this.#options.entry);
  }

  // --- The URL: sort, filters, search, pages ----------------------------------------------------------------------------------

  /** Sorts by `column` — its alias from the props; without a direction, ascending, or the other way round when it is sorted so. */
  sort(column: SortableOf<T>, direction?: SortDirection): void {
    const data = this.#data;
    const found = data.columns.find((entry) => entry.name === column);
    if (!found?.sortable) {
      refuse(
        '[marmeon:C9]',
        data.name,
        (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') &&
          `The table "${data.name}" does not sort by "${String(column)}" — it sorts by ${list(data.columns.filter((entry) => entry.sortable).map((entry) => entry.name))} (the columns' names in its props, never a database column).`,
      );
    }
    const next = direction ?? (found.sort === 'asc' ? 'desc' : 'asc');
    this.#set({ [data.query.sort]: sortValue(found.name, next), ...this.#firstPage() });
  }

  /** The URL of the page sorted by `column` (toggled like {@link sort}) — for a link that works without JavaScript. */
  sortUrl(column: SortableOf<T>, page: Pick<PageObject, 'url' | 'query' | 'queryDefaults'>): string {
    return sortUrl(this.#data, column, page);
  }

  /** Filters by `name` — `null` takes the filter off. A select filter takes one of its options, a date range `from..to`. */
  filter(name: FilterOf<T>, value: string | null): void {
    const found = this.#checkFilter(name, value);
    this.#set({ [found.key]: value === null || value === '' ? undefined : value, ...this.#firstPage() });
  }

  /** Sets several filters in one visit (a form's "Apply") — `null` takes one off; none changed, no visit. Back to page 1. */
  filterBy(values: { readonly [N in FilterOf<T>]?: string | null }): void {
    const patch: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(values) as [FilterOf<T>, string | null | undefined][]) {
      if (value === undefined) continue;
      const found = this.#checkFilter(name, value);
      // Unchanged filters stay out: nothing changed, no visit.
      if ((value || null) === found.value) continue;
      patch[found.key] = value === null || value === '' ? undefined : value;
    }
    if (Object.keys(patch).length > 0) this.#set({ ...patch, ...this.#firstPage() });
  }

  #checkFilter(name: FilterOf<T>, value: string | null) {
    const data = this.#data;
    const found = data.filters.find((entry) => entry.name === name);
    if (!found) refuse('[marmeon:C10]', data.name, (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && `The table "${data.name}" has no filter "${String(name)}" — it has ${list(data.filters.map((entry) => entry.name))}.`);
    if (value !== null && value !== '' && found.type === 'select' && !found.options.includes(value)) {
      refuse('[marmeon:C10]', data.name, (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && `The filter "${found.name}" of the table "${data.name}" takes ${list(found.options)} — not "${value}".`);
    }
    return found;
  }

  /** Searches the searchable columns — after a pause in typing (`searchDebounce`), one history entry for all of it. */
  search(value: string): void {
    const data = this.#data;
    if (!data.search) refuse('[marmeon:C10]', data.name, (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && `The table "${data.name}" cannot search — none of its visible columns is searchable.`);
    this.#set({ [data.query.search]: value === '' ? undefined : value, ...this.#firstPage() }, { debounce: this.#options.searchDebounce ?? 300, history: 'replace' });
  }

  /** Goes to page `page` (pages by number). */
  goTo(page: number): void {
    const data = this.#data;
    if (data.page.type !== 'offset' || !Number.isInteger(page) || page < 1 || page > Math.max(data.page.lastPage, 1)) {
      refuse('[marmeon:C11]', data.name, (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && `The table "${data.name}" has no page ${page}.`);
    }
    this.#set({ [data.query.page]: page });
  }

  /** The next page of a table paged by cursor. */
  next(): void {
    const data = this.#data;
    if (data.page.type !== 'cursor' || data.page.nextCursor === null) refuse('[marmeon:C11]', data.name, (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && `The table "${data.name}" has no next page.`);
    this.#set({ [data.query.cursor]: data.page.nextCursor });
  }

  /** Rows per page — one of `page.perPageOptions`. Back to the first page. */
  perPage(size: number): void {
    const data = this.#data;
    if (!data.page.perPageOptions.includes(size)) refuse('[marmeon:C11]', data.name, (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && `The table "${data.name}" shows ${list(data.page.perPageOptions.map(String))} rows per page — not ${size}.`);
    this.#set({ [data.query.perPage]: size, ...this.#firstPage() });
  }

  #firstPage(): Record<string, undefined> {
    const { query, page } = this.#data;
    return page.type === 'offset' ? { [query.page]: undefined } : { [query.cursor]: undefined };
  }

  #set(patch: Record<string, unknown>, { debounce = 0, history = 'push' }: { debounce?: number; history?: 'push' | 'replace' } = {}): void {
    const only = this.#only();
    const state = (this.#query ??= this.#navigator.use(queryState).create());
    // Another sort, filter or page is another list: the table's prop is replaced, never merged (the default of `only`).
    state.options = { ...(only ? { only } : {}), debounce, history };
    state.set(patch);
  }

  #only(): string[] | undefined {
    const prop = this.#options.prop ?? propOf(this.#navigator.page, this.#data);
    return prop === undefined ? undefined : [prop];
  }

  // --- Selection -----------------------------------------------------------------------------------------------------------------

  isSelected(row: RowOf<T>): boolean {
    return this.selection.has(keyOf(this.#data, row));
  }

  /** Ticks (or unticks) a row. */
  select(row: RowOf<T>, selected = true): void {
    this.selection.set([keyOf(this.#data, row)], selected, this.#keys());
  }

  toggle(row: RowOf<T>): void {
    this.select(row, !this.isSelected(row));
  }

  /** Ticks (or unticks) every row on this page. */
  selectAll(selected = true): void {
    this.selection.set(this.#keys(), selected, this.#keys());
  }

  /**
   * Selects every row that matches the table's state — not only those on screen. A bulk action then sends the state (`{ all: true,
   * query }`), never keys: the server parses it again and refuses more rows than the action's `max`.
   */
  selectMatching(): void {
    this.selection.selectMatching();
  }

  clearSelection(): void {
    this.selection.clear();
  }

  /** Whether every row on this page is selected (and there is one). */
  get allSelected(): boolean {
    const keys = this.#keys();
    return keys.length > 0 && keys.every((key) => this.selection.has(key));
  }

  /** How many rows are selected — every matching one counts (the total, when the page knows it). */
  get selectedCount(): number {
    const selected = this.selection;
    if (selected.matching) return this.#data.page.type === 'offset' ? this.#data.page.total : this.#data.rows.length;
    return selected.size;
  }

  #keys(): SelectionKey[] {
    return this.#data.rows.map((row) => keyOf(this.#data, row));
  }

  // --- Actions and exports -------------------------------------------------------------------------------------------------------

  /** The text `confirm` asks with when an action defined with `.confirm()` runs without one of its own. */
  confirmText = (action: string, rows: number): string => `Run "${action}" for ${rows} ${rows === 1 ? 'row' : 'rows'}?`;

  /** Runs row action `name` for `row` — then the table reloads (replacing what it showed). */
  run(name: ActionOf<T>, row: RowOf<T>, options: TableRunOptions = {}): Promise<TableRunOutcome> {
    const data = this.#data;
    const entry = data.actions.find((action) => action.name === name);
    if (!entry) refuse('[marmeon:C12]', data.name, (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && `The table "${data.name}" offers no row action "${String(name)}" to this user — it offers ${list(data.actions.map((action) => action.name))}.`);
    return this.#run(entry.url, { key: keyOf(data, row) }, entry.confirm ? (options.confirm ?? this.confirmText(entry.name, 1)) : options.confirm, options.signal, false);
  }

  /**
   * Runs bulk action `name` for what is selected: the keys ticked, or — every matching row selected — the table's state (`{ all: true,
   * query }`), never a list of keys. Then the selection is cleared and the table reloads.
   */
  runBulk(name: BulkOf<T>, options: TableRunOptions = {}): Promise<TableRunOutcome> {
    const data = this.#data;
    const entry = data.bulk.find((action) => action.name === name);
    if (!entry) refuse('[marmeon:C12]', data.name, (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && `The table "${data.name}" offers no bulk action "${String(name)}" to this user — it offers ${list(data.bulk.map((action) => action.name))}.`);
    const selected = this.selection;
    const body = selected.matching ? { all: true, query: data.state } : { keys: selected.keys };
    return this.#run(entry.url, body, entry.confirm ? (options.confirm ?? this.confirmText(entry.name, this.selectedCount)) : options.confirm, options.signal, true);
  }

  async #run(url: string, body: Record<string, unknown>, confirm: Confirm | undefined, signal: AbortSignal | undefined, bulk: boolean): Promise<TableRunOutcome> {
    const only = this.#only();
    let loaded: typeof import('./run.ts');
    try {
      // The actions feature and the page's reloads: a chunk of their own, loaded with the first run.
      loaded = await import('./run.ts');
    } catch (cause) {
      // Its code could not be loaded (offline, a deployment took the chunk away): nothing was sent.
      return { ok: false, kind: 'exception', exception: { type: 'network', cause } };
    }
    const outcome = await loaded.runTableAction(this.#navigator, { url, body, confirm, signal, only });
    if (bulk && outcome.ok) this.selection.clear();
    return outcome as TableRunOutcome;
  }

  /** The URL of export `name` — with the table's sort, search and filters (the server's state: what the page shows). */
  exportUrl(name: ExportOf<T>): string {
    return exportUrl(this.#data, name);
  }

  /** Stops what is waiting (a search not sent yet). The selection stays with its history entry. */
  dispose(): void {
    this.#query?.dispose();
    this.#query = undefined;
  }
}

/** The URL of export `name` of table `data` — with its sort, search and filters (the server's state: what the page shows). */
export function exportUrl<T extends AnyTableData>(data: T, name: ExportOf<T>): string {
  const entry = data.exports.find((item) => item.name === name);
  if (!entry) refuse('[marmeon:C12]', data.name, (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && `The table "${data.name}" offers no export "${String(name)}" to this user — it offers ${list(data.exports.map((item) => item.name))}.`);
  return entry.url;
}

/**
 * The URL of `page` sorted by `column` — ascending, or the other way round when it is sorted so — and back on its first page: for a link
 * in the column's heading that works without JavaScript (and on the server). Defaults are left out, as the server parsed them.
 */
export function sortUrl<T extends AnyTableData>(data: T, column: SortableOf<T>, page: Pick<PageObject, 'url' | 'query' | 'queryDefaults'>): string {
  const found = data.columns.find((entry) => entry.name === column && entry.sortable);
  if (!found) refuse('[marmeon:C9]', data.name, (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && `The table "${data.name}" does not sort by "${String(column)}".`);
  const first = data.page.type === 'offset' ? data.query.page : data.query.cursor;
  return urlOf(page, { [data.query.sort]: sortValue(found.name, found.sort === 'asc' ? 'desc' : 'asc'), [first]: undefined });
}

/** The page's URL with its query changed by `patch` (`undefined`: back to the default) — defaults left out, the server's own parse. */
function urlOf(page: Pick<PageObject, 'url' | 'query' | 'queryDefaults'>, patch: Record<string, unknown>): string {
  const values = pageQuery(page);
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values[key] = value;
    else if (page.queryDefaults && Object.hasOwn(page.queryDefaults, key)) values[key] = page.queryDefaults[key];
    else delete values[key];
  }
  return queryUrl(page, values);
}

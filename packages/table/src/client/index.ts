/**
 * The protocol of `@bespokecore/table` as the browser sees it (E183): what `tables.resolve(MembersTable, ctx)` sends as a page prop
 * — types and the small pure helpers that read them. UI-free and server-free: it imports nothing but the page contract, so a
 * client build may take it into any bundle (the headless `useTable` of `@bespokecore/react` builds on it).
 *
 * Everything here describes what the server decided for this request: only the columns, filters, actions and exports the user may
 * see are in it — a hidden column has no entry and no value in any row; sorting, filtering and paging go back to the server as the
 * page's query (`query` names the keys), which parses them again (an unknown or hidden one is a 400).
 */

/** A sort direction. */
export type SortDirection = 'asc' | 'desc';

/** A column the user may see — in the order the table defines them. */
export interface TableColumn<C extends string = string> {
  /** Its name in the URL and in the rows (the alias — never the database column). */
  readonly name: C;
  /** The label the definition gave (`.label('Joined')`), or null: the app labels it (its translations). */
  readonly label: string | null;
  readonly sortable: boolean;
  /** Whether `search` looks into it. */
  readonly searchable: boolean;
  /** How the table is sorted by this column right now — null when it is not. */
  readonly sort: SortDirection | null;
}

/** A filter the user may use. */
export type TableFilter<F extends string = string> =
  | {
      readonly name: F;
      readonly type: 'select';
      /** Its key in the URL (`filter[role]`, with the table's prefix). */
      readonly key: string;
      /** The values it allows. */
      readonly options: readonly string[];
      readonly value: string | null;
    }
  | {
      readonly name: F;
      readonly type: 'dateRange';
      readonly key: string;
      /** `2026-01-01..2026-03-31`, either side may be empty (`2026-01-01..`) — null when not set. */
      readonly value: string | null;
    };

/** Pages by number (the default): `count(*)` gives the total. */
export interface OffsetPage {
  readonly type: 'offset';
  readonly page: number;
  readonly perPage: number;
  /** The page sizes the table allows (`?per_page=` takes only these). */
  readonly perPageOptions: readonly number[];
  readonly total: number;
  readonly lastPage: number;
  readonly from: number | null;
  readonly to: number | null;
}

/** Pages by an encrypted cursor ("load more"): no total, stable while rows are added. */
export interface CursorPage {
  readonly type: 'cursor';
  readonly perPage: number;
  readonly perPageOptions: readonly number[];
  /** The cursor of the next page — null on the last. Opaque: encrypted and authenticated by the server. */
  readonly nextCursor: string | null;
}

/** The keys of the table's state in the page's URL — with the table's prefix (`members_sort`) when it has one. */
export interface TableQueryKeys {
  readonly sort: string;
  readonly page: string;
  readonly perPage: string;
  readonly cursor: string;
  readonly search: string;
}

/** A row action the user may see: run with `{ key }` against `url` (an action request — CSRF, JSON answer). */
export interface TableActionEntry<A extends string = string> {
  readonly name: A;
  readonly url: string;
  /** Ask before running it (`.confirm()`). */
  readonly confirm: boolean;
}

/** A bulk action the user may see: `{ keys }` or `{ all: true, query }` against `url`, at most `max` rows. */
export interface TableBulkEntry<B extends string = string> {
  readonly name: B;
  readonly url: string;
  readonly confirm: boolean;
  readonly max: number;
}

/** An export the user may use — `url` carries the table's state (sort, filters, search); a download, no JavaScript needed. */
export interface TableExportEntry<E extends string = string> {
  readonly name: E;
  readonly format: 'csv';
  readonly url: string;
}

/**
 * The prop a table sends (`TableProps<typeof MembersTable>` on the server). `R` is the row — the visible columns by name plus the
 * key; `can` holds, per row, whether each row action is allowed for it (booleans only — never a policy's reason).
 */
export interface TableData<
  R extends object = Record<string, unknown>,
  C extends string = string,
  F extends string = string,
  A extends string = string,
  B extends string = string,
  E extends string = string,
> {
  /** The table's name — unique on its page. */
  readonly name: string;
  /** Which property of a row is its key (what actions send). */
  readonly key: string;
  readonly columns: readonly TableColumn<C>[];
  readonly rows: readonly (R & { readonly can: { readonly [K in A]: boolean } })[];
  readonly sort: { readonly column: C; readonly direction: SortDirection } | null;
  /** The search, when a visible column is searchable — null otherwise. */
  readonly search: { readonly value: string } | null;
  readonly filters: readonly TableFilter<F>[];
  readonly page: OffsetPage | CursorPage;
  readonly query: TableQueryKeys;
  /**
   * The table's state as the URL had it, without defaults — what "select all matching" sends back (`{ all: true, query: state }`;
   * the server parses it again) and what an export URL carries.
   */
  readonly state: Readonly<Record<string, string>>;
  readonly actions: readonly TableActionEntry<A>[];
  readonly bulk: readonly TableBulkEntry<B>[];
  readonly exports: readonly TableExportEntry<E>[];
}

/** What a row or bulk action answers (unless its handler answered for itself): how many rows it ran for, and how many it did not. */
export interface TableActionResult<D = unknown> {
  /** Rows the action ran for. */
  readonly done: number;
  /** Rows of the table the policy refused (`authorize`) — left out, counted. */
  readonly skipped: number;
  /** Keys that are not rows of the table for this user (another tenant's, gone, made up) — left out, counted. */
  readonly missing: number;
  /** What the handler returned, when it returned something. */
  readonly data?: D;
}

/** `name` or `-name` → the column and the direction. */
export function parseSort<C extends string>(value: string): { column: C; direction: SortDirection } {
  return value.startsWith('-') ? { column: value.slice(1) as C, direction: 'desc' } : { column: value as C, direction: 'asc' };
}

/** The sort value of a column: `name` ascending, `-name` descending. */
export function sortValue(column: string, direction: SortDirection): string {
  return direction === 'desc' ? `-${column}` : column;
}

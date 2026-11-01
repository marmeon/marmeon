import type { AbilityOf, PolicyClass, ResourcelessAbility, ResourceOf } from '@marmeon/auth';
import type { ColumnReference, Database, ReferencedType, RelationName, Relations, SecretReference, SelectQuery } from '@marmeon/database';
import type { ClassResolver, HttpContext, InferInput, InferOutput, JoinNames, StandardSchemaV1 } from '@marmeon/router';
import type { Rule } from '@marmeon/validation';
import type { Translator } from '@marmeon/core';
import type { TableData } from './client/index.ts';
import { isCsvDelimiter } from './csv.ts';
import type { CsvDelimiter } from './csv-read.ts';
import { tableAttachment, type KnownOptions, type TableEndpoints, type TableEndpointsOptions } from './routes.ts';
import { isSchema, normalizeOptions } from './helpers.ts';
import { querySchema } from './state.ts';

/**
 * Who may see a part of a table — a column, a filter, an action, an export — for the whole request (no row): an ability of a policy
 * that takes no resource (`viewEmails(user)`), or a check of the request (`(ctx) => ctx.user.admin`). A `can(…)` of
 * @marmeon/auth works as a check, too: its denial (403/404) means "hidden".
 */
export type TableVisibility =
  | { readonly kind: 'policy'; readonly policy: PolicyClass; readonly ability: string }
  | { readonly kind: 'check'; readonly check: TableVisibilityCheck };

/** A visibility check of the request. */
export type TableVisibilityCheck = (ctx: any, resolve: ClassResolver) => boolean | Promise<boolean>;

/** What a column's `label(…)` function translates with: the request's translator, else the key itself. */
export type TableText = (key: string, params?: Readonly<Record<string, unknown>>) => string;

/** A policy ability for a row (or for the request, when its method takes no resource). */
export interface RowAuthorization {
  readonly policy: PolicyClass;
  readonly ability: string;
}

/**
 * `K` when it is an ability of `P` that takes no resource — asked once per request (`visible`, an export's `authorize`); otherwise the
 * message: not an ability (with the policy's abilities), or one that needs a row.
 */
export type CheckRequestAbility<P, K extends string> = string extends K
  ? ResourcelessAbility<P>
  : K extends ResourcelessAbility<P>
    ? K
    : K extends AbilityOf<P>
      ? `'${K}' takes a resource — this is asked once per request: name an ability without one (rows are asked by .authorize())`
      : `'${K}' is not an ability of this policy — it has ${JoinNames<AbilityOf<P>>}`;

/** `K` when it is an ability of `P` — asked per row (the row it takes is checked by `defineTable`); otherwise the message. */
export type CheckRowAbility<P, K extends string> = string extends K
  ? AbilityOf<P>
  : K extends AbilityOf<P>
    ? K
    : `'${K}' is not an ability of this policy — it has ${JoinNames<AbilityOf<P>>}`;

function visibility(args: readonly unknown[], where: string): TableVisibility {
  const [first, second] = args;
  if (typeof first === 'function' && typeof second === 'string') return { kind: 'policy', policy: first as PolicyClass, ability: second };
  if (typeof first === 'function' && second === undefined) return { kind: 'check', check: first as TableVisibilityCheck };
  throw new TypeError(`${where}.visible() takes a policy and one of its abilities — visible(MemberPolicy, 'viewEmails') — or a check, visible((ctx) => …).`);
}

// --- Columns ---------------------------------------------------------------------------------------------------------------

/**
 * A column of a table — built by {@link column}. `R` is the column it reads (`'name'`, `'users.created_at'`); its name in URLs and
 * props is its key in `columns` (an alias — the database column never leaves the server).
 */
export class ColumnDefinition<R extends string = string, S extends boolean = boolean, Q extends boolean = boolean, V extends boolean = boolean> {
  declare readonly '~sortable': S;
  declare readonly '~searchable': Q;
  /** `true` once `visible(…)` decides: the column may be missing — optional in the row's type. */
  declare readonly '~conditional': V;
  readonly ref: R;
  /** @internal */
  readonly isSortable: boolean;
  /** @internal */
  readonly isSearchable: boolean;
  /** @internal */
  readonly text: string | ((t: TableText) => string) | null;
  /** @internal */
  readonly visibility: TableVisibility | undefined;

  /** @internal */
  constructor(ref: R, options: { sortable?: boolean; searchable?: boolean; label?: string | ((t: TableText) => string) | null; visibility?: TableVisibility | undefined } = {}) {
    if (typeof ref !== 'string' || !/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)?$/.test(ref)) {
      throw new TypeError(`column(${JSON.stringify(ref)}): a column of the query, as "name" or "table.name".`);
    }
    this.ref = ref;
    this.isSortable = options.sortable ?? false;
    this.isSearchable = options.searchable ?? false;
    this.text = options.label ?? null;
    this.visibility = options.visibility;
  }

  /** Sortable by the URL (`?sort=joined`, `?sort=-joined`) — the key always breaks ties. */
  sortable(): ColumnDefinition<R, true, Q, V> {
    return new ColumnDefinition(this.ref, { ...this.#options(), sortable: true });
  }

  /** Looked into by the table's search (`?search=`, case-insensitive, `LIKE` wildcards taken literally) — only while visible. */
  searchable(): ColumnDefinition<R, S, true, V> {
    return new ColumnDefinition(this.ref, { ...this.#options(), searchable: true });
  }

  /**
   * A label for the props and the export's heading — otherwise the app labels the column by its name (its own translations). A
   * function gets `t(key, params?)` of the request's translator once per request (`(t) => t('members.column.name')`), the key itself
   * without one. See [columns](docs/tables.md#columns).
   */
  label(text: string | ((t: TableText) => string)): ColumnDefinition<R, S, Q, V> {
    if (typeof text !== 'string' && typeof text !== 'function') throw new TypeError(`column('${this.ref}').label(…): a text, or a function of the translator.`);
    return new ColumnDefinition(this.ref, { ...this.#options(), label: text });
  }

  /**
   * Shows the column only when the policy says so — or the check: otherwise it is not selected (not in the SQL), not in the props, the
   * devtools, a cursor or an export, and sorting or searching by it is refused (400). In the row's type it becomes optional.
   */
  visible<P extends object, const K extends string>(policy: PolicyClass<P>, ability: CheckRequestAbility<P, K>): ColumnDefinition<R, S, Q, true>;
  visible(check: TableVisibilityCheck): ColumnDefinition<R, S, Q, true>;
  visible(...args: unknown[]): ColumnDefinition<R, S, Q, true> {
    return new ColumnDefinition(this.ref, { ...this.#options(), visibility: visibility(args, `column('${this.ref}')`) });
  }

  #options() {
    return { sortable: this.isSortable, searchable: this.isSearchable, label: this.text, visibility: this.visibility };
  }
}

/** A column of the table's query: `column('name')`, `column('users.created_at').sortable()`. Checked against the query's tables. */
export function column<const R extends string>(ref: R): ColumnDefinition<R, false, false, false> {
  return new ColumnDefinition(ref);
}

// --- Filters ---------------------------------------------------------------------------------------------------------------

/** One value a filter allows, with the text shown for it. */
export interface FilterOption<V extends string = string> {
  readonly value: V;
  readonly label: string;
}

/** The options a filter lists: plain values, or values with their labels. */
export type FilterOptions<O extends string = string> = readonly (O | FilterOption<O>)[];

/**
 * Options computed for each request — `(resolve, ctx) => …`, with the request's own `ctx`. The URL then takes any value this list
 * holds for **this request** and nothing else (a 400), so the function has to scope by the tenant the way the table's query does.
 */
export type FilterOptionsSource = (resolve: ClassResolver, ctx: any) => FilterOptions | Promise<FilterOptions>;

/** A filter of the table — its key in `filters` is its name in the URL (`?filter[role]=admin`). */
export class Filter<R extends string = string, T extends 'select' | 'dateRange' | 'has' = 'select' | 'dateRange' | 'has', O extends string = string, C extends string = string> {
  readonly ref: R;
  readonly type: T;
  /** The values it allows — none for a date range, and none here when the options are computed for each request. */
  readonly options: readonly O[];
  /** @internal — the text shown for each of `options`. */
  readonly labels: readonly string[];
  /** @internal — computes the options for each request. */
  readonly source: FilterOptionsSource | undefined;
  /** @internal */
  readonly visibility: TableVisibility | undefined;
  /** @internal — `has`: the column of the related table the value is compared with. */
  readonly column: C | undefined;

  /** @internal */
  constructor(ref: R, type: T, options: FilterOptions<O> | FilterOptionsSource, visibility?: TableVisibility, column?: C) {
    const pattern = type === 'has' ? /^[A-Za-z_]\w*$/ : /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)?$/;
    if (typeof ref !== 'string' || !pattern.test(ref)) {
      throw new TypeError(`filter.${type}(${JSON.stringify(ref)}): ${type === 'has' ? 'a relation of the query\'s table' : 'a column of the query'}.`);
    }
    if (column !== undefined && (type !== 'has' || typeof column !== 'string' || !/^[A-Za-z_]\w*$/.test(column))) {
      throw new TypeError(`filter.${type}('${ref}'): "column" is a column of the related table, for filter.has() only.`);
    }
    this.ref = ref;
    this.type = type;
    this.visibility = visibility;
    this.column = column;
    if (typeof options === 'function') {
      this.options = [];
      this.labels = [];
      this.source = options;
    } else if (type === 'dateRange') {
      this.options = [];
      this.labels = [];
      this.source = undefined;
    } else {
      const given = normalizeOptions(`filter.${type}('${ref}', options)`, options);
      if (given.values.length === 0) throw new TypeError(`filter.${type}('${ref}', options): one or more options.`);
      this.options = given.values as O[];
      this.labels = given.labels;
      this.source = undefined;
    }
  }

  /** Offers the filter only when the policy (or the check) says so — otherwise using it is refused (400). */
  visible<P extends object, const K extends string>(policy: PolicyClass<P>, ability: CheckRequestAbility<P, K>): Filter<R, T, O, C>;
  visible(check: TableVisibilityCheck): Filter<R, T, O, C>;
  visible(...args: unknown[]): Filter<R, T, O, C> {
    const copy = new Filter<R, T, O, C>(this.ref, this.type, this.source ?? this.#given(), visibility(args, `filter.${this.type}('${this.ref}')`), this.column);
    return copy;
  }

  #given(): FilterOptions<O> {
    return this.options.map((value, index) => ({ value, label: this.labels[index]! }));
  }
}

/** One of `options`: `?filter[role]=admin` → `role = 'admin'`. Anything else is a 400. */
function selectFilter<const R extends string, const O extends string>(ref: R, options: readonly [O | FilterOption<O>, ...(O | FilterOption<O>)[]]): Filter<R, 'select', O>;
/** One of the options `options` computes for the request (`(resolve, ctx) => […]`): any other value is a 400. */
function selectFilter<const R extends string>(ref: R, options: FilterOptionsSource): Filter<R, 'select', string>;
function selectFilter(ref: string, options: FilterOptions | FilterOptionsSource): Filter<string, 'select', string> {
  return new Filter(ref, 'select', options);
}

/**
 * The rows that have a related row whose `column` (default `id`) is the value: `?filter[team]=3` → `whereHas('members', …)`. `relation`
 * is a relation of the query's table and `column` one of the related table's (both checked against the schema); the value must be one
 * of `options` (a list, or a function computing it for the request), so the URL never reaches a related row the request may not choose.
 */
function hasFilter<const R extends string, const O extends string>(relation: R, options: readonly [O | FilterOption<O>, ...(O | FilterOption<O>)[]]): Filter<R, 'has', O, 'id'>;
function hasFilter<const R extends string, const O extends string, const C extends string>(relation: R, options: readonly [O | FilterOption<O>, ...(O | FilterOption<O>)[]], settings: { readonly column: C }): Filter<R, 'has', O, C>;
function hasFilter<const R extends string>(relation: R, options: FilterOptionsSource): Filter<R, 'has', string, 'id'>;
function hasFilter<const R extends string, const C extends string>(relation: R, options: FilterOptionsSource, settings: { readonly column: C }): Filter<R, 'has', string, C>;
function hasFilter(relation: string, options: FilterOptions | FilterOptionsSource, settings: { readonly column?: string } = {}): Filter<string, 'has', string, string> {
  return new Filter(relation, 'has', options, undefined, settings.column);
}

/** The filters a table offers: `filter.select()`, `filter.dateRange()` and `filter.has()`. See docs/tables.md#filters. */
export const filter = {
  select: selectFilter,
  has: hasFilter,
  /** A range of days, both ends included: `?filter[joined]=2026-01-01..2026-03-31` (either end may be empty: `2026-01-01..`). */
  dateRange<const R extends string>(ref: R): Filter<R, 'dateRange', never> {
    return new Filter(ref, 'dateRange', []);
  },
};

// --- Actions, bulk actions, exports ---------------------------------------------------------------------------------------

/** A row action's class (REPR, built per request with constructor injection): `handle(row, ctx)`. */
export type RowActionClass<R = any, C = any> = new (...args: any[]) => { handle(row: R, ctx: C, input: any): unknown };

/** A bulk action's class: `handle(rows, ctx)` — the rows the user may act on, never more than the action's `max`. */
export type BulkActionClass<R = any, C = any> = new (...args: any[]) => { handle(rows: readonly R[], ctx: C, input: any): unknown };

/** The schema of an action's input — or a function that builds it per request (its `resolve` and the request's `ctx`), for rules like `exists`. */
export type ActionInputSource<S extends StandardSchemaV1 = StandardSchemaV1> = S | ((resolve: ClassResolver, ctx: any) => S | Promise<S>);

/** What an action's input schema is, whether given as a schema or as a function building one. */
export type InputSchemaOf<I> = (I extends StandardSchemaV1 ? I : I extends (...args: any[]) => infer R ? Awaited<R> : never) extends infer S extends StandardSchemaV1 ? S : never;

interface ActionOptions {
  readonly authorization?: RowAuthorization | undefined;
  readonly visibility?: TableVisibility | undefined;
  readonly confirm?: boolean;
  readonly max?: number;
  readonly input?: ActionInputSource | undefined;
}

function checkInput(source: unknown, where: string): void {
  if (!isSchema(source) && typeof source !== 'function') throw new TypeError(`${where}.input(…): a Standard Schema (rules of @marmeon/validation, Valibot, Zod …) or a function that builds one.`);
}

/** A row action — built by {@link action}. */
export class RowAction<H extends RowActionClass = RowActionClass, P = unknown, K extends string = string, S extends StandardSchemaV1 = never> {
  declare readonly '~policy': P;
  declare readonly '~ability': K;
  declare readonly '~input': S;
  readonly handler: H;
  /** @internal */
  readonly authorization: RowAuthorization | undefined;
  /** @internal */
  readonly visibility: TableVisibility | undefined;
  /** @internal */
  readonly confirms: boolean;
  /** @internal */
  readonly inputSource: ActionInputSource | undefined;

  /** @internal */
  constructor(handler: H, options: ActionOptions = {}) {
    if (typeof handler !== 'function' || typeof handler.prototype?.handle !== 'function') throw new TypeError('action(Handler): a class with handle(row, ctx).');
    this.handler = handler;
    this.authorization = options.authorization;
    this.visibility = options.visibility;
    this.confirms = options.confirm ?? false;
    this.inputSource = options.input;
  }

  /**
   * The policy decides per row: `authorize(MemberPolicy, 'deactivate')` asks `deactivate(user, row)` for each row — on the page (the
   * row's `can.deactivate`, all rows of the page at once) and again when the action runs (a 403 when it says no).
   */
  authorize<P2 extends object, const K2 extends string>(policy: PolicyClass<P2>, ability: CheckRowAbility<P2, K2>): RowAction<H, P2, K2, S> {
    return new RowAction(this.handler, { ...this.#options(), authorization: { policy, ability } });
  }

  /** Offers the action only when the policy (or the check) says so, for the whole request — hidden, it is not in the props and its endpoint answers 403. */
  visible<P2 extends object, const K2 extends string>(policy: PolicyClass<P2>, ability: CheckRequestAbility<P2, K2>): RowAction<H, P, K, S>;
  visible(check: TableVisibilityCheck): RowAction<H, P, K, S>;
  visible(...args: unknown[]): RowAction<H, P, K, S> {
    return new RowAction(this.handler, { ...this.#options(), visibility: visibility(args, 'action(…)') });
  }

  /** The browser asks before it runs the action (`confirm` in the props). */
  confirm(): RowAction<H, P, K, S> {
    return new RowAction(this.handler, { ...this.#options(), confirm: true });
  }

  /**
   * The values the browser sends along (`table.run(name, row, { input })`): a Standard Schema, or a function building one per request
   * (`(resolve, ctx) => …`, for rules like `exists` that ask the database). The server validates them before the row is read — a 422 under
   * `input.<field>` — and hands the handler the schema's output as `handle(row, ctx, input)`. See docs/tables.md#an-action-with-input.
   */
  input<I extends ActionInputSource>(schema: I): RowAction<H, P, K, InputSchemaOf<I>> {
    checkInput(schema, 'action(…)');
    return new RowAction(this.handler, { ...this.#options(), input: schema });
  }

  #options(): ActionOptions {
    return { authorization: this.authorization, visibility: this.visibility, confirm: this.confirms, input: this.inputSource };
  }
}

/** A row action: `action(DeactivateMember).authorize(MemberPolicy, 'deactivate').confirm()`. */
export function action<H extends RowActionClass>(handler: H): RowAction<H, unknown, never, never> {
  return new RowAction(handler);
}

/** The most rows a bulk action takes by default — chosen ones or "all matching". */
export const DEFAULT_BULK_MAX = 1000;

/** A bulk action — built by {@link bulk}. */
export class BulkAction<H extends BulkActionClass = BulkActionClass, P = unknown, K extends string = string, S extends StandardSchemaV1 = never> {
  declare readonly '~policy': P;
  declare readonly '~ability': K;
  declare readonly '~input': S;
  readonly handler: H;
  /** @internal */
  readonly authorization: RowAuthorization | undefined;
  /** @internal */
  readonly visibility: TableVisibility | undefined;
  /** @internal */
  readonly confirms: boolean;
  /** @internal */
  readonly inputSource: ActionInputSource | undefined;
  /** @internal */
  readonly limit: number;

  /** @internal */
  constructor(handler: H, options: ActionOptions = {}) {
    if (typeof handler !== 'function' || typeof handler.prototype?.handle !== 'function') throw new TypeError('bulk(Handler): a class with handle(rows, ctx).');
    const max = options.max ?? DEFAULT_BULK_MAX;
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError(`bulk(…).max(${max}): a whole number ≥ 1.`);
    this.handler = handler;
    this.authorization = options.authorization;
    this.visibility = options.visibility;
    this.confirms = options.confirm ?? false;
    this.inputSource = options.input;
    this.limit = max;
  }

  /** The policy decides per row: rows it refuses are left out — and counted (`skipped` in the answer). */
  authorize<P2 extends object, const K2 extends string>(policy: PolicyClass<P2>, ability: CheckRowAbility<P2, K2>): BulkAction<H, P2, K2, S> {
    return new BulkAction(this.handler, { ...this.#options(), authorization: { policy, ability } });
  }

  /** Offers the bulk action only when the policy (or the check) says so — hidden, its endpoint answers 403. */
  visible<P2 extends object, const K2 extends string>(policy: PolicyClass<P2>, ability: CheckRequestAbility<P2, K2>): BulkAction<H, P, K, S>;
  visible(check: TableVisibilityCheck): BulkAction<H, P, K, S>;
  visible(...args: unknown[]): BulkAction<H, P, K, S> {
    return new BulkAction(this.handler, { ...this.#options(), visibility: visibility(args, 'bulk(…)') });
  }

  confirm(): BulkAction<H, P, K, S> {
    return new BulkAction(this.handler, { ...this.#options(), confirm: true });
  }

  /** At most `rows` rows at once — chosen ones or "all matching" (default 1000); more is refused (422), never cut short. */
  max(rows: number): BulkAction<H, P, K, S> {
    return new BulkAction(this.handler, { ...this.#options(), max: rows });
  }

  /**
   * The values the browser sends along (`table.runBulk(name, { input })`), also for "all matching": a Standard Schema, or a function
   * building one per request (`(resolve, ctx) => …`, for rules like `exists`). The server validates them before any row is read — a 422 under
   * `input.<field>` — and hands the handler the schema's output as `handle(rows, ctx, input)`. See docs/tables.md#an-action-with-input.
   */
  input<I extends ActionInputSource>(schema: I): BulkAction<H, P, K, InputSchemaOf<I>> {
    checkInput(schema, 'bulk(…)');
    return new BulkAction(this.handler, { ...this.#options(), input: schema });
  }

  #options(): ActionOptions {
    return { authorization: this.authorization, visibility: this.visibility, confirm: this.confirms, max: this.limit, input: this.inputSource };
  }
}

/** A bulk action: `bulk(DeactivateMembers).authorize(MemberPolicy, 'deactivate').max(500)`. */
export function bulk<H extends BulkActionClass>(handler: H): BulkAction<H, unknown, never, never> {
  return new BulkAction(handler);
}

/** What an export recorder is told: which export is about to start, how many rows it holds and the state it was asked for. */
export interface TableExportInfo {
  /** The table's name. */
  readonly table: string;
  /** The export's key in the table's `export` (such as `csv`). */
  readonly export: string;
  /** The rows that matched when the export started: the count of the filtered query the file is read from. */
  readonly rows: number;
  /** The visible columns the file holds, by name. */
  readonly columns: readonly string[];
  /** The sort, search and filters of the request, as the table parsed and checked them. */
  readonly state: {
    readonly sort: { readonly column: string; readonly direction: 'asc' | 'desc' } | undefined;
    readonly search: string;
    readonly filters: Readonly<Record<string, string>>;
  };
}

/** An export recorder's class: `handle(info, ctx)` — runs once, before the first byte of an export that is authorized and within its limit. */
export type ExportRecorderClass<C = any> = new (...args: any[]) => { handle(info: TableExportInfo, ctx: C): unknown };

/** The most rows an export takes by default — more is refused (422), never cut short. */
export const DEFAULT_EXPORT_MAX = 10_000;

/**
 * What an export's `delimiter(…)` function decides from: the request's `ctx`, the resolver, and the request's translator (`undefined`
 * without `@marmeon/i18n`) — `(ctx, resolve, translator) => (translator?.locale === 'de' ? ';' : ',')`.
 */
export type TableDelimiterChoice = (ctx: any, resolve: ClassResolver, translator: Translator | undefined) => CsvDelimiter | Promise<CsvDelimiter>;

/** An export — built by {@link exportCsv}. */
export class TableExport {
  readonly format = 'csv' as const;
  /** @internal */
  readonly visibility: TableVisibility | undefined;
  /** @internal */
  readonly limit: number;
  /** @internal */
  readonly recorder: ExportRecorderClass | undefined;
  /** @internal */
  readonly separator: CsvDelimiter | TableDelimiterChoice;

  /** @internal */
  constructor(visibility?: TableVisibility, max: number = DEFAULT_EXPORT_MAX, recorder?: ExportRecorderClass, separator: CsvDelimiter | TableDelimiterChoice = ',') {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError(`exportCsv().max(${max}): a whole number ≥ 1.`);
    this.visibility = visibility;
    this.limit = max;
    this.recorder = recorder;
    this.separator = separator;
  }

  /**
   * At most `rows` rows per export (default 10 000): an export over more is refused with a 422 before a byte is streamed — narrow
   * the filter. Exports read the whole filtered table; throttle the table's routes as well (`throttle()` of @marmeon/cache).
   */
  max(rows: number): TableExport {
    return new TableExport(this.visibility, rows, this.recorder, this.separator);
  }

  /**
   * Who may export: an ability without a resource (`export(user)`) — or a check. Without it, everyone who sees the table may
   * export what they see (the visible columns, every page). A refused export is a 403 and is not in the props.
   */
  authorize<P extends object, const K extends string>(policy: PolicyClass<P>, ability: CheckRequestAbility<P, K>): TableExport;
  authorize(check: TableVisibilityCheck): TableExport;
  authorize(...args: unknown[]): TableExport {
    return new TableExport(visibility(args, 'exportCsv()'), this.limit, this.recorder, this.separator);
  }

  /**
   * Records every export: the recorder's `handle(info, ctx)` runs once the export is authorized, its state checked and its rows
   * counted within the limit, and before the first byte. A refused export never reaches it. If it throws, nothing is sent: the
   * download fails with that error. The entry records an export that started: if its first query fails or the stream breaks, the
   * entry stays though the file was not delivered in full. See [exports](docs/tables.md#exports).
   */
  onExport(Recorder: ExportRecorderClass): TableExport {
    if (typeof Recorder !== 'function' || typeof Recorder.prototype?.handle !== 'function') throw new TypeError('exportCsv().onExport(Recorder): a class with handle(info, ctx).');
    return new TableExport(this.visibility, this.limit, Recorder, this.separator);
  }

  /**
   * The separator of the file: `','` (default), `';'` (what a spreadsheet in a locale with a decimal comma opens as columns) or a
   * tab — or a function `(ctx, resolve, translator)` that answers per request, from the user or the request's language. Nothing
   * else is a delimiter (a `TypeError` when the table is defined, or on the request when a function answers it): not a quote, a line
   * break, a formula sign or more than one character. Every cell stays quoted and escaped. See [exports](docs/tables.md#exports).
   */
  delimiter(choice: CsvDelimiter | TableDelimiterChoice): TableExport {
    if (typeof choice !== 'function' && !isCsvDelimiter(choice)) throw new TypeError(`exportCsv().delimiter(${JSON.stringify(choice)}): "," ";" or a tab, or a function of the request.`);
    return new TableExport(this.visibility, this.limit, this.recorder, choice);
  }
}

/** A CSV export of the visible columns, as the table is filtered and sorted — streamed, formulas escaped (OWASP). */
export function exportCsv(): TableExport {
  return new TableExport();
}

// --- The definition --------------------------------------------------------------------------------------------------------

/** Any column definition. */
export type AnyColumn = ColumnDefinition<string, boolean, boolean, boolean>;
/** Any filter. */
export type AnyFilter = Filter<string, 'select' | 'dateRange' | 'has', string, string>;
/** Any row action. */
export type AnyRowAction = RowAction<RowActionClass, any, string, any>;
/** Any bulk action. */
export type AnyBulkAction = BulkAction<BulkActionClass, any, string, any>;

/** How a table pages: by number (default, with a total) or by an encrypted cursor (`cursor: true`, "load more"). */
export interface TablePagination {
  /** The page sizes `?per_page=` allows — the first is the default (default `[25, 50, 100]`). */
  readonly perPage?: number | readonly [number, ...number[]];
  /** Keyset pagination with an encrypted cursor (`?cursor=`) instead of page numbers — no `count(*)`. */
  readonly cursor?: boolean;
}

/** What `defineTable` keeps — and what the table's server code reads. */
export interface TableDefinition {
  readonly name: string;
  readonly prefix: string | undefined;
  readonly authorize: ((ctx: any, resolve: ClassResolver) => boolean | Promise<boolean>) | undefined;
  readonly query: (db: any, ctx: any) => SelectQuery<any, any, any>;
  readonly key: string;
  /** How keys from the browser are parsed (`integer` for a key given by name). */
  readonly keyType: KeyType;
  readonly columns: Readonly<Record<string, AnyColumn>>;
  readonly filters: Readonly<Record<string, AnyFilter>>;
  readonly defaultSort: string | undefined;
  readonly perPage: readonly [number, ...number[]];
  readonly cursor: boolean;
  readonly actions: Readonly<Record<string, AnyRowAction>>;
  readonly bulk: Readonly<Record<string, AnyBulkAction>>;
  readonly exports: Readonly<Record<string, TableExport>>;
}

const TABLE_TYPES = Symbol.for('marmeon.table.types');

/**
 * A table: its definition, and its types for the client — `TableProps<typeof MembersTable>`. Use it with
 * `tables.resolve(MembersTable, ctx)` (the page's prop) and `Route.get('/', Page).attach(MembersTable.endpoints())` (its actions and exports).
 */
export interface DataTable<
  Row extends object = any,
  Ctx = any,
  C extends string = string,
  F extends string = string,
  A extends string = string,
  B extends string = string,
  E extends string = string,
  QV extends object = TableQueryValues,
  S extends string = C,
  AI extends object = {},
  BI extends object = {},
> {
  readonly [TABLE_TYPES]?: {
    readonly row: Row;
    readonly ctx: Ctx;
    readonly columns: C;
    readonly sortable: S;
    readonly filters: F;
    readonly actions: A;
    readonly bulk: B;
    readonly exports: E;
    readonly actionInputs: AI;
    readonly bulkInputs: BI;
  };
  /** @internal */
  readonly definition: TableDefinition;
  /**
   * The table's state in the URL as a query schema (rules of @marmeon/validation): `?sort=`, `?page=` (or `?cursor=`), `?per_page=`,
   * `?search=`, `?filter[name]=` — with the table's prefix. Give it to the page's request: `defineRequest({ query: MembersTable.query })`,
   * or spread its fields next to the page's own: `r.query({ ...MembersTable.query.entries, tab: … })`. Stricter than other query
   * fields: an unknown sort, a filter that is none, a page size the table does not offer is a **400**, never a quiet default.
   */
  readonly query: TableQuerySchema<QV>;
  /**
   * The table's action, bulk and export endpoints, for the page that shows it: `Route.get('/', Page).attach(MembersTable.endpoints())`.
   * They carry the page's middleware, bindings and checks, its request's `authorize` included; `options.middleware` runs on all of
   * them, `export`, `bulk` and `action` on one kind. Every table is attached to the page that resolves it, one without actions and
   * exports too. See docs/tables.md#the-controller-and-the-routes.
   */
  endpoints<const O extends TableEndpointsOptions = {}>(options?: O & KnownOptions<O>): TableEndpoints<Ctx, O>;
}

/** What a table's query fields parse to — by key (`sort`, `page`, `filter[role]`, …, with the table's prefix). */
export type TableQueryValues = { readonly [key: string]: string | number | undefined };

/**
 * The table's query schema — an object rule of @marmeon/validation (spread its `entries` into another `r.query()`). `entries` has
 * a rule for every key; a filter or cursor the URL leaves out parses to `undefined`.
 */
export interface TableQuerySchema<QV extends object = TableQueryValues> extends StandardSchemaV1<{ readonly [K in keyof QV]?: string | readonly string[] }, QV> {
  readonly entries: { readonly [K in keyof QV]-?: Rule<QV[K], string | readonly string[] | undefined> };
}

type KeyPrefix<P extends string> = P extends '' ? '' : `${P}_`;
type SizesOf<Pg> = Pg extends { readonly perPage: infer S } ? (S extends readonly (infer N)[] ? N : S) : 25 | 50 | 100;
type SearchableNames<Cols> = { [A in keyof Cols]: Cols[A] extends ColumnDefinition<string, boolean, true> ? A : never }[keyof Cols];
type FilterValue<F> = F extends Filter<string, 'select' | 'has', infer O> ? O : string;

/** The parsed query of a table — what `ctx.query` and `useQueryState` hold for its keys. */
export type QueryValuesOf<P extends string, Cols, Filters, Pg> = Simplify<
  ([SortableNames<Cols>] extends [never]
    ? {}
    : [SortableForEveryone<Cols>] extends [never]
      ? { readonly [K in `${KeyPrefix<P>}sort`]?: SortableNames<Cols> | `-${SortableNames<Cols>}` }
      : { readonly [K in `${KeyPrefix<P>}sort`]: SortableNames<Cols> | `-${SortableNames<Cols>}` }) &
  (Pg extends { readonly cursor: true } ? { readonly [K in `${KeyPrefix<P>}cursor`]?: string } : { readonly [K in `${KeyPrefix<P>}page`]: number }) & {
    readonly [K in `${KeyPrefix<P>}per_page`]: SizesOf<Pg>;
  } & ([SearchableNames<Cols>] extends [never] ? {} : { readonly [K in `${KeyPrefix<P>}search`]: string }) & {
    readonly [N in keyof Filters & string as `${KeyPrefix<P>}filter[${N}]`]?: FilterValue<Filters[N]>;
  }
>;

/** What the browser gets for table `T`: the page prop `tables.resolve(T, ctx)` resolves to. */
export type TableProps<T> = T extends DataTable<infer Row, any, infer C, infer F, infer A, infer B, infer E, any, infer S, infer AI, infer BI> ? TableData<Row, C, F, A, B, E, S, AI, BI> : never;

/** A row of table `T` as the server hands it to actions and policies: the key and the visible columns (by name). */
export type DataTableRow<T> = T extends DataTable<infer Row> ? Row : never;

// --- Type checks (the messages a wrong definition shows) -------------------------------------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The plain column names of the query's tables — for "it has …" in messages. */
type PlainColumns<DB, TB extends keyof DB> = Extract<ColumnReference<DB, TB>, `${string}`> extends infer All extends string ? Exclude<All, `${string}.${string}` | SecretReference<DB, TB>> : never;

type ColumnProblem<DB, TB extends keyof DB, R extends string, O = {}> =
  R extends SecretReference<DB, TB>
    ? `'${R}' is a secret column — a table never reads it (its migration marked it .secret())`
    : R extends ColumnReference<DB, TB> | Selected<DB, TB, O>
      ? never
      : `'${R}' is not a column of the table's query — it has ${JoinNames<PlainColumns<DB, TB> | Selected<DB, TB, O>>}`;

/** The names of the values the base query selects itself (`withCount(…, { as })`) — not columns of its tables. */
type Selected<DB, TB extends keyof DB, O> = Exclude<keyof O & string, PlainColumns<DB, TB>>;

/** A key that names a value the base query selects: not a column of a table of the query, so the query must be a derived table. */
type KeyProblem<DB, TB extends keyof DB, K extends string, O> = K extends Selected<DB, TB, O>
  ? `'${K}' is a value the query selects — a key is a column of a table of the query: select from the query as a derived table, db.selectFrom(query.as('rows')), and name 'rows.${K}'`
  : ColumnProblem<DB, TB, K>;

/** A column that reads a value the base query selects: under that name, and not searched (the search runs in WHERE). */
type SelectedProblem<DB, TB extends keyof DB, O, A, C> =
  C extends ColumnDefinition<infer R extends string, boolean, infer Q>
    ? R extends Selected<DB, TB, O>
      ? A extends R
        ? Q extends true
          ? `'${R}' is a value the query selects — it can be shown and sorted by, not searched (the search runs in the query's WHERE) — or select from the query as a derived table, db.selectFrom(query.as('rows')), whose columns can be searched`
          : never
        : `'${A & string}' reads '${R}', a value the query selects — name the column '${R}': ${R}: column('${R}')`
      : never
    : never;

/** Marks a wrong entry: the property's name is the message. */
type Problem<M extends string> = { readonly [K in M]: true };

/**
 * Every column must be a column of the query (and none a secret one) or a value the query selects, under its name; `can` is the
 * rows' abilities.
 */
export type CheckColumns<DB, TB extends keyof DB, Cols, O = {}> = {
  [A in keyof Cols]: A extends 'can'
    ? Problem<`'can' is taken — a row's abilities are its 'can'; name the column otherwise`>
    : Cols[A] extends ColumnDefinition<infer R extends string>
      ? [ColumnProblem<DB, TB, R, O> | SelectedProblem<DB, TB, O, A, Cols[A]>] extends [never]
        ? unknown
        : Problem<ColumnProblem<DB, TB, R, O> | SelectedProblem<DB, TB, O, A, Cols[A]>>
      : unknown;
};

/** The table a relation of the query's tables leads to. */
type RelatedTable<DB, TB extends keyof DB, R extends string> = {
  [T in TB]: T extends keyof Relations ? (R extends keyof Relations[T] ? (Relations[T][R] extends { readonly table: infer X extends keyof DB } ? X : never) : never) : never;
}[TB];

/** `filter.has()` names a relation of the query's tables and a column of the related table (a secret one is refused, in the types and when the table is loaded). */
type HasProblem<DB, TB extends keyof DB, R extends string, C extends string> = R extends RelationName<DB, TB>
  ? C extends keyof DB[RelatedTable<DB, TB, R>] & string
    ? C extends SecretReference<DB, RelatedTable<DB, TB, R>>
      ? Problem<`'${C}' is a secret column of '${RelatedTable<DB, TB, R> & string}' — a table never reads it (its migration marked it .secret())`>
      : unknown
    : Problem<`'${C}' is no column of the table '${RelatedTable<DB, TB, R> & string}' that '${R}' leads to — name one: filter.has('${R}', options, { column: … })`>
  : Problem<`'${R}' is no relation of the query's tables — it has ${RelationName<DB, TB>}`>;

/** Every filter must read a column of the query's tables — not a value the query selects, which its `WHERE` cannot see. */
export type CheckFilters<DB, TB extends keyof DB, Filters, O = {}> = {
  [N in keyof Filters]: Filters[N] extends Filter<infer R extends string, 'has', string, infer C extends string>
    ? HasProblem<DB, TB, R, C>
    : Filters[N] extends Filter<infer R extends string>
    ? R extends Selected<DB, TB, O>
      ? Problem<`'${R}' is a value the query selects — it can be shown and sorted by, not filtered by (a filter runs in the query's WHERE) — or select from the query as a derived table, db.selectFrom(query.as('rows')), whose columns can be filtered by`>
      : [ColumnProblem<DB, TB, R>] extends [never]
        ? unknown
        : Problem<ColumnProblem<DB, TB, R>>
    : unknown;
};

type ScalarKey = string | number;

/**
 * How a key arrives from the browser and is parsed before it reaches the database — a value that does not parse is no row (404,
 * or `missing` in a bulk action), so text never meets an integer column: `integer` (a safe integer), `bigint` (digits, as text —
 * Postgres `bigint`), `string` (any text up to 200 characters), `uuid`.
 */
export type KeyType = 'integer' | 'bigint' | 'string' | 'uuid';

/** The key as written: a number column by name (`'id'`, an integer key), or `{ column, type }`. */
export type KeyInput = string | { readonly column: string; readonly type: KeyType };

/** The key's column in a {@link KeyInput}. */
export type KeyColumn<K> = K extends { readonly column: infer C extends string } ? C : K & string;

/** The key by name only: a column of the query whose values are numbers (an integer key) — a text key names its type. */
export type CheckColumnKey<DB, TB extends keyof DB, K extends string, O = {}> = string extends K
  ? ColumnReference<DB, TB>
  : [KeyProblem<DB, TB, K, O>] extends [never]
    ? ReferencedType<DB, TB, K> extends number
      ? K
      : ReferencedType<DB, TB, K> extends ScalarKey
        ? `the key '${K}' holds text — say how to read it: key: { column: '${K}', type: 'string' } (or 'uuid', 'bigint')`
        : `the key '${K}' is no string or number column — rows are acted on by their key`
    : KeyProblem<DB, TB, K, O>;

/** The key with its type: a string or number column of the query. */
export type CheckKeyColumn<DB, TB extends keyof DB, K extends string, O = {}> = string extends K
  ? ColumnReference<DB, TB>
  : [KeyProblem<DB, TB, K, O>] extends [never]
    ? ReferencedType<DB, TB, K> extends ScalarKey
      ? K
      : `the key '${K}' is no string or number column — rows are acted on by their key`
    : KeyProblem<DB, TB, K, O>;

/** The sortable columns' names. */
type SortableNames<Cols> = { [A in keyof Cols]: Cols[A] extends ColumnDefinition<string, true> ? A : never }[keyof Cols] & string;
/** Sortable columns every user sees (no `.visible()`) — what a default sort may name. */
type SortableForEveryone<Cols> = { [A in keyof Cols]: Cols[A] extends ColumnDefinition<string, true, boolean, false> ? A : never }[keyof Cols] & string;

/** `name` or `-name` of a sortable column. */
export type CheckSort<Cols, S extends string> = string extends S
  ? SortableNames<Cols> | `-${SortableNames<Cols>}`
  : S extends SortableForEveryone<Cols> | `-${SortableForEveryone<Cols>}`
    ? S
    : S extends SortableNames<Cols> | `-${SortableNames<Cols>}`
      ? `'${S}' is a column with .visible() — whoever may not see it would get a 400; the default sort is a column everyone sees`
      : [SortableNames<Cols>] extends [never]
        ? `'${S}' is not a sortable column — mark one with .sortable()`
        : `'${S}' is not a sortable column — it sorts by ${JoinNames<SortableNames<Cols> | `-${SortableNames<Cols>}`>}`;

/** The name a key column has in a row: its last part (`users.id` → `id`). */
type KeyName<K extends string> = K extends `${string}.${infer C}` ? KeyName<C> : K;

type ValueOf<DB, TB extends keyof DB, O, C> =
  C extends ColumnDefinition<infer R extends string> ? (R extends Selected<DB, TB, O> ? O[R & keyof O] : ReferencedType<DB, TB, R>) : never;

/** A row as the table sends it (and hands it to actions and policies): the visible columns by name, plus the key. */
type RowOf<DB, TB extends keyof DB, Cols, K extends string, O = {}> = Simplify<
  { readonly [A in keyof Cols as Cols[A] extends ColumnDefinition<string, boolean, boolean, true> ? never : A]: ValueOf<DB, TB, O, Cols[A]> } & {
    readonly [A in keyof Cols as Cols[A] extends ColumnDefinition<string, boolean, boolean, true> ? A : never]?: ValueOf<DB, TB, O, Cols[A]>;
  } & { readonly [P in KeyName<K>]: ReferencedType<DB, TB, K> }
>;

type PolicyProblem<P, K extends string, Row, Name extends string> = [P] extends [unknown]
  ? unknown extends P
    ? never
    : K extends AbilityOf<P>
      ? Row extends ResourceOf<P, K>
        ? never
        : `'${Name}': ${K}(user, row) of its policy takes another row than the table's (${JoinNames<keyof Row & string>})`
      : `'${Name}': '${K}' is not an ability of its policy — it has ${JoinNames<AbilityOf<P>>}`
  : never;

type HandlerProblem<H, Row, Name extends string, Bulk extends boolean> = H extends new (...args: any[]) => { handle(first: infer First, ...rest: any[]): unknown }
  ? (Bulk extends true ? readonly Row[] : Row) extends First
    ? never
    : `'${Name}': its handler's handle(${Bulk extends true ? 'rows' : 'row'}, ctx) takes other rows than the table's — they have ${JoinNames<keyof Row & string>}`
  : never;

/** `handle(row, ctx, input)`: the third parameter is what `.input()` validates — without a schema there is none to take. */
type InputProblem<H, S, Name extends string, Bulk extends boolean> = H extends new (...args: any[]) => { handle: (...args: infer Args) => unknown }
  ? [S] extends [never]
    ? Args extends [any, any, ...infer Rest]
      ? [Rest] extends [[]]
        ? never
        : `'${Name}': its handler's handle(${Bulk extends true ? 'rows' : 'row'}, ctx, input) takes an input, but the action has no .input(schema)`
      : never
    : Args extends [any, any, infer Taken, ...any[]]
      ? InferOutput<Extract<S, StandardSchemaV1>> extends Taken
        ? never
        : `'${Name}': its handler's handle(${Bulk extends true ? 'rows' : 'row'}, ctx, input) takes another input than the schema gives`
      : never
  : never;

/** Row actions: their handler takes the table's row; their ability is one of the policy's and takes that row. */
export type CheckActions<Row, Actions> = {
  [N in keyof Actions]: Actions[N] extends RowAction<infer H, infer P, infer K, infer S>
    ? [HandlerProblem<H, Row, N & string, false> | PolicyProblem<P, K, Row, N & string> | InputProblem<H, S, N & string, false>] extends [never]
      ? unknown
      : Problem<HandlerProblem<H, Row, N & string, false> | PolicyProblem<P, K, Row, N & string> | InputProblem<H, S, N & string, false>>
    : unknown;
};

/** Bulk actions: like row actions, with `handle(rows, ctx)`. */
export type CheckBulk<Row, Bulk> = {
  [N in keyof Bulk]: Bulk[N] extends BulkAction<infer H, infer P, infer K, infer S>
    ? [HandlerProblem<H, Row, N & string, true> | PolicyProblem<P, K, Row, N & string> | InputProblem<H, S, N & string, true>] extends [never]
      ? unknown
      : Problem<HandlerProblem<H, Row, N & string, true> | PolicyProblem<P, K, Row, N & string> | InputProblem<H, S, N & string, true>>
    : unknown;
};

/**
 * What a table's query gets as `ctx`: the request — its user (after `authenticate()`), its bound route parameters — but **not** its
 * query: the base query is the same for the page and for the table's endpoints, which have another URL.
 */
export type TableContext<TState extends object = {}, TParams extends object = {}> = Omit<HttpContext<TState, TParams>, 'query'>;

/**
 * The type a table's `query` has to fit, not one to annotate with: it types an unannotated `db` as `never`. Annotate the query's own
 * parameters instead — `ctx` as `TableContext<Authenticated>`, `db` as `Database<'module'>` to keep it inside its module; unannotated,
 * `db` sees every table. See `docs/tables.md#the-base-query`.
 */
export type TableQuery = { bivariance(db: never, ctx: any): SelectQuery<any, any, any> }['bivariance'];

/** The tables of a base query's result, its tables in scope, and the context it needs. */
type DbOf<Q> = Q extends (...args: any[]) => SelectQuery<infer DB, any, any> ? DB : never;
type TbOf<Q> = Q extends (...args: any[]) => SelectQuery<infer DB, infer TB, any> ? Extract<TB, keyof DB> : never;
type OutOf<Q> = Q extends (...args: any[]) => SelectQuery<any, any, infer O> ? O : {};
type CtxOf<Q> = Q extends (db: any, ctx: infer C) => unknown ? (unknown extends C ? TableContext : C) : TableContext;

/** The input of {@link defineTable}. */
export interface TableInput<Q extends TableQuery, Cols, K extends string, Filters, Sort extends string, Actions, Bulk, Exports, P extends string = string, Pg extends TablePagination = TablePagination> {
  /** Unique among the app's tables on a page — part of its endpoints' paths (`/_tables/members/…`). Letters, digits, `-` and `_`. */
  readonly name: string;
  /** Prefix of its URL keys (`members_sort`, `members_filter[role]`) — for more than one table on a page. */
  readonly prefix?: P;
  /**
   * Who may see the table at all — asked on the page and in every action and export: a `can(Policy, 'ability')` or any check.
   * Like the query, it does not read `ctx.query`, which differs between the page and the endpoints. See `docs/tables.md#who-may-see-the-table`.
   */
  readonly authorize?: (ctx: NoInfer<CtxOf<Q>> & { readonly query: never }, resolve: ClassResolver) => boolean | Promise<boolean>;
  /**
   * The base query — every row the table may ever show this request (the tenant, the scope): `(db, ctx: TableContext<Authenticated>) =>
   * db.selectFrom('users').where('team_id', '=', ctx.user.team_id)`. Pages, actions, bulk actions (also "all matching") and exports
   * all start from it. Select nothing: the table selects its visible columns itself (whatever the query selects stays on the server) —
   * except a value it computes, `withCount('profile_links', { as: 'links' })`, which `links: column('links')` shows and sorts by.
   */
  readonly query: Q;
  /**
   * The column that identifies a row — what actions send: a number column by name (`'users.id'`, read as an integer), or with its
   * type (`{ column: 'uuid', type: 'uuid' }`, see {@link KeyType}) — every key the browser sends is parsed by it first.
   */
  readonly key: CheckColumnKey<DbOf<Q>, TbOf<Q>, K, OutOf<Q>> | { readonly column: CheckKeyColumn<DbOf<Q>, TbOf<Q>, K, OutOf<Q>>; readonly type: KeyType };
  readonly columns: Cols & NoInfer<CheckColumns<DbOf<Q>, TbOf<Q>, Cols, OutOf<Q>>>;
  readonly filters?: Filters & NoInfer<CheckFilters<DbOf<Q>, TbOf<Q>, Filters, OutOf<Q>>>;
  /** The sort without `?sort=` — `'-joined'`; default: the first sortable column. The key is always the last order. */
  readonly defaultSort?: CheckSort<Cols, Sort>;
  readonly pagination?: Pg;
  readonly actions?: Actions & NoInfer<CheckActions<RowOf<DbOf<Q>, TbOf<Q>, Cols, K, OutOf<Q>>, Actions>>;
  readonly bulk?: Bulk & NoInfer<CheckBulk<RowOf<DbOf<Q>, TbOf<Q>, Cols, K, OutOf<Q>>, Bulk>>;
  readonly export?: Exports;
}

/** What the browser sends along per action that takes input — the schema's input type; actions without one are left out. */
type InputsOf<Actions> = {
  [N in keyof Actions as Actions[N] extends { readonly '~input': infer S } ? ([S] extends [never] ? never : N) : never]: Actions[N] extends { readonly '~input': infer S extends StandardSchemaV1 }
    ? InferInput<S>
    : never;
};

/** The table `defineTable` makes of its input. */
type TableOf<Q, Cols, K extends string, Filters, Actions, Bulk, Exports, P extends string, Pg> = DataTable<
  RowOf<DbOf<Q>, TbOf<Q>, Cols, K, OutOf<Q>>,
  CtxOf<Q>,
  keyof Cols & string,
  keyof Filters & string,
  keyof Actions & string,
  keyof Bulk & string,
  keyof Exports & string,
  QueryValuesOf<P, Cols, Filters, Pg>,
  // The names spelled out (a key-remapped type, no alias): a wrong sort in the browser reads "… not assignable to '"name" | "joined"'".
  keyof { [A in keyof Cols as Cols[A] extends ColumnDefinition<string, true> ? A : never]: 0 } & string,
  InputsOf<Actions>,
  InputsOf<Bulk>
>;

/**
 * A server-driven table, typed from the query's tables: wrong column names, a secret column, a sort that is not sortable or an
 * action whose policy takes another row are compile errors. See `docs/tables.md#defining-a-table`.
 */
export function defineTable<
  const Cols extends Record<string, AnyColumn>,
  const K extends string,
  const Filters extends Record<string, AnyFilter> = {},
  const Sort extends string = never,
  Actions extends Record<string, AnyRowAction> = {},
  Bulk extends Record<string, AnyBulkAction> = {},
  Exports extends Record<string, TableExport> = {},
  const P extends string = '',
  const Pg extends TablePagination = {},
  D extends { readonly selectFrom: (...args: never) => unknown } = Database,
  C extends TableContext = TableContext,
  R extends SelectQuery<any, any, any> = SelectQuery<any, any, any>,
>(input: TableInput<(db: D, ctx: C) => R, Cols, K, Filters, Sort, Actions, Bulk, Exports, P, Pg>): TableOf<(db: D, ctx: C) => R, Cols, K, Filters, Actions, Bulk, Exports, P, Pg> {
  const definition = normalize(input as unknown as RawInput);
  return { definition, query: querySchema(definition), endpoints: (options?: TableEndpointsOptions) => tableAttachment(definition, options) } as unknown as TableOf<(db: D, ctx: C) => R, Cols, K, Filters, Actions, Bulk, Exports, P, Pg>;
}

interface RawInput {
  name: unknown;
  prefix?: unknown;
  authorize?: unknown;
  query: unknown;
  key: unknown;
  columns: unknown;
  filters?: unknown;
  defaultSort?: unknown;
  pagination?: TablePagination;
  actions?: unknown;
  bulk?: unknown;
  export?: unknown;
}

const NAME = /^[a-z][a-z0-9_-]{0,63}$/i;

function entries<T>(value: unknown, what: string, Kind: abstract new (...args: any[]) => T, table: string): Readonly<Record<string, T>> {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || value === null) throw new TypeError(`defineTable('${table}'): ${what} is an object of named entries.`);
  const out: Record<string, T> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!NAME.test(name)) throw new TypeError(`defineTable('${table}'): ${what} '${name}' — names are letters, digits, '-' and '_' (they go into URLs).`);
    if (!(entry instanceof Kind)) throw new TypeError(`defineTable('${table}'): ${what} '${name}' is not built by the package's helper.`);
    out[name] = entry;
  }
  return Object.freeze(out);
}

function normalize(input: RawInput): TableDefinition {
  const name = input.name;
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError(`defineTable({ name: ${JSON.stringify(name)} }): letters, digits, '-' and '_' (it is part of the table's URLs).`);
  if (input.prefix !== undefined && (typeof input.prefix !== 'string' || !/^[a-z][a-z0-9]{0,31}$/i.test(input.prefix))) {
    throw new TypeError(`defineTable('${name}'): prefix ${JSON.stringify(input.prefix)} — letters and digits.`);
  }
  if (typeof input.query !== 'function') throw new TypeError(`defineTable('${name}'): query is (db, ctx) => db.selectFrom(…).`);
  if (input.authorize !== undefined && typeof input.authorize !== 'function') throw new TypeError(`defineTable('${name}'): authorize is (ctx, resolve) => boolean.`);
  const keyInput = input.key as KeyInput;
  const key = typeof keyInput === 'string' ? keyInput : keyInput?.column;
  const keyType: KeyType = typeof keyInput === 'string' ? 'integer' : keyInput?.type;
  if (typeof key !== 'string' || !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/.test(key)) throw new TypeError(`defineTable('${name}'): key is a column of the query.`);
  if (!['integer', 'bigint', 'string', 'uuid'].includes(keyType)) throw new TypeError(`defineTable('${name}'): key type ${JSON.stringify(keyType)} — 'integer', 'bigint', 'string' or 'uuid'.`);
  const columns = entries(input.columns, 'column', ColumnDefinition, name);
  if (Object.keys(columns).length === 0) throw new TypeError(`defineTable('${name}'): a table needs a column.`);
  if ('can' in columns) throw new TypeError(`defineTable('${name}'): the name 'can' is taken — a row's abilities are its 'can'.`);
  const keyName = key.slice(key.lastIndexOf('.') + 1);
  const clash = Object.entries(columns).find(([alias, col]) => alias === keyName && col.ref !== key && col.ref.slice(col.ref.lastIndexOf('.') + 1) !== keyName);
  if (clash) throw new TypeError(`defineTable('${name}'): the column '${keyName}' reads ${clash[1].ref}, but the key '${key}' has that name in every row — rename the column.`);
  const filters = entries(input.filters, 'filter', Filter, name);
  const actions = entries(input.actions, 'action', RowAction, name);
  const bulkActions = entries(input.bulk, 'bulk action', BulkAction, name);
  const exports = entries(input.export, 'export', TableExport, name);
  const sortable = Object.entries(columns).filter(([, col]) => col.isSortable).map(([alias]) => alias);
  // The default sort is every user's: a column only some may see (`.visible()`) would answer 400 to the others on the page itself.
  const forEveryone = sortable.filter((alias) => columns[alias]!.visibility === undefined);
  const defaultSort = input.defaultSort ?? forEveryone[0];
  if (defaultSort !== undefined && (typeof defaultSort !== 'string' || !sortable.includes(defaultSort.replace(/^-/, '')))) {
    throw new TypeError(`defineTable('${name}'): defaultSort ${JSON.stringify(defaultSort)} is not a sortable column (${sortable.join(', ') || 'none is .sortable()'}).`);
  }
  if (typeof defaultSort === 'string' && !forEveryone.includes(defaultSort.replace(/^-/, ''))) {
    throw new TypeError(
      `defineTable('${name}'): defaultSort ${JSON.stringify(defaultSort)} is a column with .visible() — whoever may not see it would get a 400 on the page itself; sort by a column everyone sees (${forEveryone.join(', ') || 'mark one without .visible() as .sortable()'}).`,
    );
  }
  const perPageOption = input.pagination?.perPage ?? [25, 50, 100];
  const perPage = (Array.isArray(perPageOption) ? perPageOption : [perPageOption]) as unknown as readonly [number, ...number[]];
  if (perPage.length === 0 || !perPage.every((size) => Number.isSafeInteger(size) && size >= 1 && size <= 1000) || new Set(perPage).size !== perPage.length) {
    throw new RangeError(`defineTable('${name}'): pagination.perPage takes different whole numbers from 1 to 1000, got ${JSON.stringify(perPageOption)}.`);
  }
  const cursor = input.pagination?.cursor === true;
  if (cursor && defaultSort === undefined) throw new TypeError(`defineTable('${name}'): a cursor pages along a sort — mark a column .sortable().`);
  return Object.freeze({
    name,
    prefix: input.prefix as string | undefined,
    authorize: input.authorize as TableDefinition['authorize'],
    query: input.query as TableDefinition['query'],
    key,
    keyType,
    columns,
    filters,
    defaultSort: defaultSort as string | undefined,
    perPage: Object.freeze([...perPage]) as unknown as readonly [number, ...number[]],
    cursor,
    actions,
    bulk: bulkActions,
    exports,
  });
}

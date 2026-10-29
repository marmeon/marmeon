import { AsyncLocalStorage } from 'node:async_hooks';
import type { Gate, PolicyClass } from '@marmeon/auth';
import { cursorPaginate, outsideTransaction, paginate, sql, type Connection, type CursorEncrypter, type SelectQuery } from '@marmeon/database';
import { leaveOutSelections, selectionsOf } from '@marmeon/database/internal';
import { json, RedirectResult, type JsonResult } from '@marmeon/http';
import { ACTION_HEADER, isJsonResult, isRedirectResult, PAGE_HEADER } from '@marmeon/http/internal';
import { addVary, expectsJson, EXPECTS_JSON_VARY, HttpError, ValidationError, type ClassResolver, type HttpContext, type RouteDefinition, type Router } from '@marmeon/router';
import { fillPath, matchParams } from '@marmeon/router/internal';
import * as v from 'valibot';
import type { TableActionResult, TableColumn, TableData, TableFilter } from './client/index.ts';
import { csvLine, CSV_BOM } from './csv.ts';
import { isSchema, normalizeOptions, type ActionInputSource, type AnyBulkAction, type AnyColumn, type AnyFilter, type AnyRowAction, type KeyType, type DataTable, type TableDefinition, type TableExport, type TableProps, type TableVisibility } from './define.ts';
import { parseState, queryKeys, stateQuery, TableQueryError, type TableState } from './state.ts';

/** The request context a table's query needs. */
export type ContextOfTable<T> = T extends DataTable<any, infer Ctx> ? Ctx : never;

/** Rows a CSV export reads per query. */
const EXPORT_BATCH = 500;

/** Where `tableRoutes` registered a table's endpoints — by route, so the page can link to them. */
export type TableEndpointKind = 'action' | 'bulk' | 'export';

const ENDPOINTS = new WeakMap<RouteDefinition, { readonly definition: TableDefinition; readonly kind: TableEndpointKind }>();

/** @internal — `tableRoutes` records its routes. */
export function recordEndpoint(route: RouteDefinition, definition: TableDefinition, kind: TableEndpointKind): void {
  ENDPOINTS.set(route, { definition, kind });
}

/** @internal — the table an endpoint route serves. */
export function endpointOf(route: RouteDefinition): { readonly definition: TableDefinition; readonly kind: TableEndpointKind } {
  const found = ENDPOINTS.get(route);
  if (!found) throw new Error(`${route.path} is no route of a table — register table endpoints with tableRoutes(Route, Table).`);
  return found;
}

/** What one request may see of a table. */
interface View {
  readonly columns: readonly (readonly [string, AnyColumn])[];
  readonly filters: readonly (readonly [string, AnyFilter])[];
  readonly actions: readonly (readonly [string, AnyRowAction])[];
  readonly bulk: readonly (readonly [string, AnyBulkAction])[];
  readonly exports: readonly (readonly [string, TableExport])[];
  /** The options a select or `has` filter allows for this request — computed once, on first ask; `undefined` for a filter without options. */
  readonly options: (name: string) => Promise<ResolvedOptions | undefined>;
}

/** A filter's options for one request: as they are shown, and the values the URL may carry. */
interface ResolvedOptions {
  readonly values: readonly string[];
  readonly labels: readonly string[];
  readonly allowed: ReadonlySet<string>;
}

/** What `DataTables` reads of the schema's metadata to check a relation filter: the relations and the columns (without the secret ones) of each table. */
export interface RelationMetadata {
  readonly fresh: boolean;
  readonly relations: { get(table: string): ReadonlyMap<string, { readonly table: string }> | undefined };
  readonly columns: { get(table: string): readonly string[] | undefined };
}

/** The related-table column each `has` filter of a definition compares with, qualified (`profile_links.label`) — once the definition was checked against the schema. */
const CHECKED = new WeakMap<TableDefinition, ReadonlyMap<string, string>>();

type Row = Record<string, unknown>;

const RowKey = v.union([v.pipe(v.number(), v.safeInteger()), v.pipe(v.string(), v.minLength(1), v.maxLength(200))]);

/** The body of a row action: the key of the row, and the action's input (checked against its schema, not here). */
const ActionBody = v.object({ key: RowKey, input: v.optional(v.unknown()) });

/**
 * Resolves tables per request: the page's prop (`resolve`), and the work of the endpoints `tableRoutes` registers — row actions,
 * bulk actions, exports. Built per request (the policies are the request user's).
 *
 * The order is the security model: **who may see the table** (`authorize`) → **what they may see** (column, filter, action and
 * export visibility by policy) → **the state**, strictly parsed and checked against what is visible (a hidden column cannot be sorted,
 * searched or filtered by: 400) → **the projection** (only the visible columns and the key are selected) → the props (only those,
 * picked by name). Every endpoint starts again at the top — nothing the browser sends is trusted: an action's row is looked up in the
 * base query, its policy asked again.
 */
export class DataTables {
  readonly #db: Connection<any>;
  readonly #gate: () => Gate;
  readonly #resolve: ClassResolver;
  readonly #router: Router;
  readonly #encrypter: () => CursorEncrypter;
  readonly #metadata: (() => RelationMetadata) | undefined;

  /** @internal — the container builds it (`TableServiceProvider`); an app injects `DataTables`. */
  constructor(db: Connection<any>, gate: () => Gate, resolve: ClassResolver, router: Router, encrypter: () => CursorEncrypter, metadata?: () => RelationMetadata) {
    this.#db = db;
    this.#gate = gate;
    this.#resolve = resolve;
    this.#router = router;
    this.#encrypter = encrypter;
    this.#metadata = metadata;
  }

  /**
   * The page's prop for `table`: the visible columns, this page of rows (only their visible columns and key), the state, and what
   * the user may do — as a lazy prop it runs only when the response includes it: `members: () => this.#tables.resolve(MembersTable, ctx)`.
   */
  async resolve<T extends DataTable>(table: T, ctx: ContextOfTable<T>): Promise<TableProps<T>> {
    const definition = table.definition;
    const context = ctx as unknown as HttpContext;
    await this.#authorizeTable(definition, context);
    await this.#verify(definition, context);
    assertQuerySchema(definition, context);
    const view = await this.#view(definition, context);
    const state = parseState(definition, new URL(context.request.url).searchParams);
    await checkState(definition, state, view);
    const filtered = this.#filtered(definition, context, state, view);
    const projected = project(definition, filtered, view);
    const keyName = keyNameOf(definition);
    let rows: Row[];
    let page: TableData['page'];
    if (definition.cursor) {
      const sort = state.sort!;
      const result = await cursorPaginate(this.#db.selectFrom(projected.as('table_rows')).selectAll() as SelectQuery<any, any, Row>, {
        column: sort.column,
        key: keyName,
        cursor: state.cursor,
        perPage: state.perPage,
        direction: sort.direction,
        encrypter: this.#encrypter(),
        // The table's own cursors only: another table's with the same order does not decrypt here.
        name: `table:${definition.name}`,
      });
      rows = result.data;
      page = { type: 'cursor', perPage: state.perPage, perPageOptions: definition.perPage, nextCursor: result.meta.nextCursor };
    } else {
      const result = await paginate(this.#db, ordered(definition, projected, state), { page: state.page, perPage: state.perPage });
      rows = result.data as Row[];
      page = { type: 'offset', perPageOptions: definition.perPage, ...result.meta };
    }
    const picked = rows.map((row) => pick(row, view, keyName));
    const can = await this.#abilities(view.actions, picked);
    const keys = queryKeys(definition);
    const query = stateQuery(definition, state);
    const urls = this.#endpoints(definition, context, view);
    const data: TableData = {
      name: definition.name,
      key: keyName,
      columns: view.columns.map(
        ([name, col]): TableColumn => ({
          name,
          label: col.text,
          sortable: col.isSortable,
          searchable: col.isSearchable,
          sort: state.sort?.column === name ? state.sort.direction : null,
        }),
      ),
      rows: picked.map((row, index) => ({ ...row, can: can[index]! })),
      sort: state.sort ? { column: state.sort.column, direction: state.sort.direction } : null,
      search: view.columns.some(([, col]) => col.isSearchable) ? { value: state.search } : null,
      filters: await Promise.all(
        view.filters.map(async ([name, entry]): Promise<TableFilter> => {
          const value = state.filters[name] ?? null;
          if (entry.type === 'dateRange') return { name, type: 'dateRange', key: keys.filter(name), value };
          const { values, labels } = (await view.options(name))!;
          return { name, type: entry.type, key: keys.filter(name), options: values, labels, value };
        }),
      ),
      page,
      query: { sort: keys.sort, page: keys.page, perPage: keys.perPage, cursor: keys.cursor, search: keys.search },
      state: query,
      actions: view.actions.map(([name, entry]) => ({ name, url: urls.action(name), confirm: entry.confirms })),
      bulk: view.bulk.map(([name, entry]) => ({ name, url: urls.bulk(name), confirm: entry.confirms, max: entry.limit })),
      exports: view.exports.map(([name, entry]) => ({ name, format: 'csv' as const, url: urls.export(name, query), max: entry.limit })),
    };
    return data as unknown as TableProps<T>;
  }

  /**
   * A row action, from its endpoint: the table, the action, its visibility and the row's policy — all checked again.
   * @internal
   */
  async runAction(definition: TableDefinition, name: string, ctx: HttpContext): Promise<unknown> {
    await this.#authorizeTable(definition, ctx);
    const entry = Object.hasOwn(definition.actions, name) ? definition.actions[name]! : undefined;
    if (!entry) throw new HttpError(404);
    if (!(await this.#visible(entry.visibility, ctx))) throw forbidden(); // a hidden action: refused when called directly too
    const body = await parseBody(ActionBody, ctx);
    const input = await this.#input(entry.inputSource, body.input, ctx);
    const view = await this.#view(definition, ctx);
    // Parsed by the key's type first: a key that is none (text for an integer key) is no row — it never reaches the database.
    const key = parseKey(definition.keyType, body.key);
    if (key === undefined) throw new HttpError(404);
    const keyName = keyNameOf(definition);
    const found = await project(definition, this.#base(definition, ctx, view), view).where(definition.key, '=', key).limit(1).executeTakeFirst();
    // Not a row of this table for this user — another tenant's, gone, made up: the same 404 either way.
    if (!found) throw new HttpError(404);
    const row = pick(found as Row, view, keyName);
    if (entry.authorization) {
      const allowed = await this.#gate().allows(entry.authorization.policy as PolicyClass<any>, entry.authorization.ability as never, row as never);
      if (!allowed) throw forbidden();
    }
    const result = await (this.#resolve(entry.handler) as { handle(row: unknown, ctx: unknown, input: unknown): unknown }).handle(row, ctx, input);
    return answer(ctx, result, { done: 1, skipped: 0, missing: 0 });
  }

  /**
   * A bulk action, from its endpoint: chosen keys (`{ keys }`) ∩ the base query ∩ the policy per row — or "all matching"
   * (`{ all: true, query }`: the table's state, parsed again here, never a list the browser made up). More rows than the action's
   * `max` is a 422; rows the policy refuses are left out and counted (`skipped`), keys that are no rows of the table too (`missing`).
   * @internal
   */
  async runBulk(definition: TableDefinition, name: string, ctx: HttpContext): Promise<unknown> {
    await this.#authorizeTable(definition, ctx);
    await this.#verify(definition, ctx);
    const entry = Object.hasOwn(definition.bulk, name) ? definition.bulk[name]! : undefined;
    if (!entry) throw new HttpError(404);
    if (!(await this.#visible(entry.visibility, ctx))) throw forbidden(); // a hidden bulk action: refused when called directly too
    const body = await parseBody(bulkBody(entry.limit), ctx);
    // Before any row is read: values the schema refuses never reach the database, whichever rows were chosen.
    const input = await this.#input(entry.inputSource, body.input, ctx);
    const view = await this.#view(definition, ctx);
    const keyName = keyNameOf(definition);
    let rows: Row[];
    let missing = 0;
    if (!('all' in body)) {
      const keys = [...new Set(body.keys.map(String))];
      // Keys that do not parse by the key's type are no rows of the table: counted as missing, never sent to the database.
      const usable = [...new Set(keys.map((key) => parseKey(definition.keyType, key)).filter((key) => key !== undefined))];
      const found = usable.length === 0 ? [] : await project(definition, this.#base(definition, ctx, view), view).where(definition.key, 'in', usable).execute();
      rows = (found as Row[]).map((row) => pick(row, view, keyName));
      missing = keys.length - rows.length;
    } else {
      // A form without JavaScript sends `all=1` and posts to the bulk URL with the table's query; an action sends `{ all: true, query }`.
      const state = parseState(definition, body.query ? Object.entries(body.query) : new URL(ctx.request.url).searchParams);
      await checkState(definition, state, view);
      const filtered = this.#filtered(definition, ctx, state, view);
      // At most max + 1: one more than allowed says "too many" without counting them all.
      const found = await ordered(definition, project(definition, filtered, view), state).limit(entry.limit + 1).execute();
      if (found.length > entry.limit) {
        throw new ValidationError({ all: [`More than ${entry.limit} rows match — narrow the filter (this action takes at most ${entry.limit}).`] });
      }
      rows = (found as Row[]).map((row) => pick(row, view, keyName));
    }
    let allowed = rows;
    if (entry.authorization) { // the policy per row: refused rows are left out and counted
      const { policy, ability } = entry.authorization;
      const answers = (await this.#gate().withAbilities(rows as never[], policy as PolicyClass<any>, [ability] as never)) as unknown as { can: Record<string, boolean> }[];
      allowed = rows.filter((_, index) => answers[index]!.can[ability] === true);
    }
    const skipped = rows.length - allowed.length;
    const result = allowed.length > 0 ? await (this.#resolve(entry.handler) as { handle(rows: unknown, ctx: unknown, input: unknown): unknown }).handle(allowed, ctx, input) : undefined;
    return answer(ctx, result, { done: allowed.length, skipped, missing });
  }

  /**
   * What an action's `.input()` schema makes of the body's `input` (a 422 under `input.<field>` when it refuses) — and a 422 for an input
   * the action does not take, so a field that does nothing is never taken for one that is checked.
   */
  async #input(source: ActionInputSource | undefined, given: unknown, ctx: HttpContext): Promise<unknown> {
    if (source === undefined) {
      if (given !== undefined) throw new ValidationError({ input: ['This action takes no input.'] });
      return undefined;
    }
    const schema = isSchema(source) ? source : await source(this.#resolve, ctx);
    const result = await schema['~standard'].validate(given, { libraryOptions: { marmeon: { resolve: this.#resolve, ctx, live: false } } });
    if (result.issues) {
      throw ValidationError.fromIssues(result.issues.map((issue) => ({ ...issue, path: ['input', ...(issue.path ?? [])] })), {});
    }
    return result.value;
  }

  /**
   * An export, from its endpoint: its own authorization, the visible columns only, filtered and sorted as the URL says (parsed
   * strictly) — streamed in batches, every cell escaped against formula injection, `no-store`.
   * @internal
   */
  async export(definition: TableDefinition, name: string, ctx: HttpContext): Promise<Response> {
    await this.#authorizeTable(definition, ctx);
    await this.#verify(definition, ctx);
    const entry = Object.hasOwn(definition.exports, name) ? definition.exports[name]! : undefined;
    if (!entry) throw new HttpError(404);
    if (!(await this.#visible(entry.visibility, ctx))) throw forbidden(); // the export's own authorization
    const view = await this.#view(definition, ctx); // the export's columns: the visible ones
    const state = parseState(definition, new URL(ctx.request.url).searchParams);
    await checkState(definition, state, view);
    const filtered = this.#filtered(definition, ctx, state, view);
    // Its limit first (one count): an export over it is refused before a byte is streamed — never a file cut short.
    const { count } = (await this.#db
      .selectFrom(filtered.select(sql<number>`1`.as('row')).as('exported'))
      .select(sql<number | string>`count(*)`.as('count'))
      .executeTakeFirstOrThrow()) as { count: number | string };
    if (Number(count) > entry.limit) {
      throw new HttpError(422, `More than ${entry.limit} rows match — narrow the filter (an export takes at most ${entry.limit}).`);
    }
    const names = view.columns.map(([alias]) => alias);
    const header = csvLine(view.columns.map(([alias, col]) => col.text ?? alias));
    // Batch after batch by the key (keyset), never by OFFSET: each goes on after the last row written — in the table's order, then
    // the key — so a row deleted or added meanwhile shifts no later row out of the file or into it twice.
    const keyName = keyNameOf(definition);
    const rows = this.#db.selectFrom(project(definition, filtered, view).as('table_rows')).selectAll() as SelectQuery<any, any, Row>;
    const encrypter = this.#encrypter();
    const batch = (cursor: string | null) =>
      cursorPaginate(rows, {
        column: state.sort?.column ?? keyName,
        key: keyName,
        cursor,
        perPage: EXPORT_BATCH,
        direction: state.sort?.direction ?? 'asc',
        encrypter,
        // The position never leaves the server; its own context all the same.
        name: `table-export:${definition.name}`,
      });
    const encoder = new TextEncoder();
    const lines = (batchRows: readonly Row[]) => batchRows.map((row) => csvLine(names.map((alias) => row[alias]))).join('');
    // The first batch before the answer: a failing query is an error page, not a cut-off file.
    const first = await batch(null);
    // Later batches run once the handler has answered — a framework boundary: in the request's context (its log context, its
    // request id) but outside any transaction that was open around the handler (it may have finished by then).
    const inRequest = AsyncLocalStorage.snapshot();
    let next = first.meta.nextCursor;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(CSV_BOM + header + lines(first.data)));
        if (next === null) controller.close();
      },
      async pull(controller) {
        if (next === null) return;
        const page = await inRequest(() => outsideTransaction(() => batch(next)));
        next = page.meta.nextCursor;
        if (page.data.length > 0) controller.enqueue(encoder.encode(lines(page.data)));
        if (next === null) controller.close();
      },
    });
    const day = new Date().toISOString().slice(0, 10);
    return new Response(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        // The table's name is letters, digits, '-' and '_' (defineTable checks it): nothing to escape, no path, no header injection.
        'content-disposition': `attachment; filename="${definition.name}-${day}.csv"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  // --- the parts ----------------------------------------------------------------------------------------------------------

  async #authorizeTable(definition: TableDefinition, ctx: HttpContext): Promise<void> {
    if (definition.authorize && !(await definition.authorize(ctx, this.#resolve))) throw forbidden();
  }

  async #visible(visibility: TableVisibility | undefined, ctx: HttpContext): Promise<boolean> {
    if (!visibility) return true;
    if (visibility.kind === 'policy') return this.#gate().allows(visibility.policy as PolicyClass<any>, visibility.ability as never);
    try {
      return (await visibility.check(ctx, this.#resolve)) === true;
    } catch (error) {
      // `can(…)` throws its denial: hidden, not an error page.
      if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return false;
      throw error;
    }
  }

  /** What this request may see — each visibility asked once. */
  async #view(definition: TableDefinition, ctx: HttpContext): Promise<View> {
    const answers = new Map<TableVisibility, Promise<boolean>>();
    const ask = (visibility: TableVisibility | undefined) => {
      if (!visibility) return Promise.resolve(true);
      let answer = answers.get(visibility);
      if (!answer) answers.set(visibility, (answer = this.#visible(visibility, ctx)));
      return answer;
    };
    const keep = async <E extends { readonly visibility: TableVisibility | undefined }>(record: Readonly<Record<string, E>>) => {
      const out: (readonly [string, E])[] = [];
      // One after another: a policy that queries must not open a connection per entry at once.
      for (const [name, entry] of Object.entries(record)) if (await ask(entry.visibility)) out.push([name, entry]);
      return out;
    };
    const columns = await keep(definition.columns);
    // A filter reads its column: on a column this request may not see it is hidden too — whatever its own visibility says (a filter
    // on a hidden column would answer, by its counts, what the column hides).
    const shown = new Set(columns.map(([, col]) => col));
    const hidden = Object.values(definition.columns).filter((col) => !shown.has(col));
    // (`has` reads a related row's column, not one of the table's.)
    const filters = (await keep(definition.filters)).filter(([, filter]) => filter.type === 'has' || !hidden.some((col) => sameColumn(col.ref, filter.ref)));
    const options = new Map<string, Promise<ResolvedOptions | undefined>>();
    return {
      columns,
      filters,
      options: (name) => {
        let found = options.get(name);
        if (!found) options.set(name, (found = this.#optionsOf(definition, name, ctx)));
        return found;
      },
      actions: await keep(definition.actions),
      bulk: await keep(definition.bulk),
      exports: await keep(definition.exports),
    };
  }

  /**
   * Checks the table's `has` filters against the schema, once per definition: the relation must belong to a table of the base query
   * and the column to the related table (a secret column is none). A misdeclared filter is a developer error on the table's first
   * request, whatever the URL carries.
   */
  async #verify(definition: TableDefinition, ctx: HttpContext): Promise<void> {
    if (CHECKED.has(definition)) return;
    const filters = Object.entries(definition.filters).filter(([, entry]) => entry.type === 'has');
    const qualified = new Map<string, string>();
    if (filters.length > 0) {
      const metadata = this.#metadata?.();
      if (!metadata) throw new Error(`Table "${definition.name}": filter.has() needs the schema's metadata, which this DataTables was built without.`);
      if (!metadata.fresh) await sql`select 1`.execute(this.#db);
      const node = (definition.query(this.#db, ctx) as unknown as { toOperationNode(): any }).toOperationNode();
      const tables = [...(node.from?.froms ?? []), ...(node.joins ?? []).map((join: any) => join.table)].flatMap((item: any): string[] => {
        const table = item?.table ?? item?.node?.table;
        return typeof table?.identifier?.name === 'string' ? [table.identifier.name] : [];
      });
      for (const [name, entry] of filters) {
        const where = `Table "${definition.name}": the filter '${name}' (filter.has('${entry.ref}'))`;
        const found = tables.flatMap((table) => metadata.relations.get(table)?.get(entry.ref) ?? []);
        if (found.length !== 1) {
          throw new Error(`${where} needs ${found.length === 0 ? `a relation '${entry.ref}' of ${tables.join(', ') || 'the query'}, which has none` : `exactly one table of the query with a relation '${entry.ref}', but ${found.length} have it`}.`);
        }
        const related = found[0]!.table;
        const column = entry.column ?? 'id';
        if (!metadata.columns.get(related)?.includes(column)) {
          throw new Error(`${where} compares with ${related}.${column}, which is no column of ${related} (or a secret one) — name one: filter.has('${entry.ref}', options, { column: … }).`);
        }
        qualified.set(name, `${related}.${column}`);
      }
    }
    CHECKED.set(definition, qualified);
  }

  /** The options of one filter for this request: a function is called here, with the request's `ctx`, and its list checked. */
  async #optionsOf(definition: TableDefinition, name: string, ctx: HttpContext): Promise<ResolvedOptions | undefined> {
    const entry = Object.hasOwn(definition.filters, name) ? definition.filters[name] : undefined;
    if (!entry || entry.type === 'dateRange') return undefined;
    // Rebuilt from the named fields, whichever way they came: nothing else an option carries reaches the props.
    const { values, labels } = entry.source
      ? normalizeOptions(`Table "${definition.name}": the options of the filter '${name}'`, await entry.source(this.#resolve, ctx))
      : { values: [...entry.options], labels: [...entry.labels] };
    return { values, labels, allowed: new Set(values) };
  }

  /** The base query — without the values it selects for a column this request may not see (`withCount(…)` of a hidden column). */
  #base(definition: TableDefinition, ctx: HttpContext, view: View): SelectQuery<any, any, any> {
    const query = definition.query(this.#db, ctx);
    const { selected, secret } = selectionsOf(query);
    const asked = Object.entries(definition.columns).find(([, col]) => secret.has(col.ref));
    if (asked) {
      throw new Error(`Table "${definition.name}": the column '${asked[0]}' reads ${asked[1].ref}, a secret column its query asks for with secret() — a table never shows one.`);
    }
    // Under its own name: the projection cannot rename a value the query selects (SQL has no alias of an alias in one select).
    const renamed = Object.entries(definition.columns).find(([alias, col]) => selected.has(col.ref) && alias !== col.ref);
    if (renamed) {
      const [alias, { ref }] = renamed;
      throw new Error(`Table "${definition.name}": the column '${alias}' reads ${ref}, a value its query selects — name the column ${ref}: ${ref}: column('${ref}').`);
    }
    const shown = new Set(view.columns.map(([, col]) => col));
    const hidden = new Set(Object.values(definition.columns).flatMap((col) => (selected.has(col.ref) && !shown.has(col) ? [col.ref] : [])));
    return leaveOutSelections(query, hidden);
  }

  /** The base query with the state's filters and search — on visible columns and filters only (checked before). */
  #filtered(definition: TableDefinition, ctx: HttpContext, state: TableState, view: View): SelectQuery<any, any, any> {
    let query = this.#base(definition, ctx, view);
    const selected = selectedBy(query);
    for (const [name, value] of Object.entries(state.filters)) {
      const entry = definition.filters[name]!;
      if (entry.type === 'has') {
        // A bound value on the related table's column, and only ever one more AND on the base query: the filter narrows, never widens.
        // The column is qualified with the related table: an unqualified name the related table lacks would resolve to the outer row's.
        const column = CHECKED.get(definition)?.get(name);
        if (column === undefined) throw new Error(`Table "${definition.name}": the filter '${name}' was not checked against the schema.`);
        query = query.whereHas(entry.ref as never, ((related: any) => related.where(column, '=', value)) as never);
        continue;
      }
      if (selected.has(entry.ref)) {
        throw new Error(`Table "${definition.name}": the filter '${name}' reads ${entry.ref}, a value its query selects — a filter runs in the query's WHERE, which cannot see it.`);
      }
      if (entry.type === 'select') {
        query = query.where(entry.ref, '=', value);
      } else {
        const [from = '', to = ''] = value.split('..');
        if (from) query = query.where(entry.ref, '>=', from);
        if (to) query = query.where(entry.ref, '<', nextDay(to));
      }
    }
    const searched = view.columns.filter(([, col]) => col.isSearchable);
    if (state.search && searched.length > 0) {
      const value = searched.find(([, col]) => selected.has(col.ref));
      if (value) {
        throw new Error(
          `Table "${definition.name}": the column '${value[0]}' is a value its query selects — it can be shown and sorted by, not searched: the search runs in the query's WHERE, which cannot see it.`,
        );
      }
      const pattern = `%${state.search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where((eb) => eb.or(searched.map(([, col]) => sql<boolean>`lower(${sql.ref(col.ref)}) like ${pattern} escape '\\'`)));
    }
    return query;
  }

  /** Each row's `can`: per row action, whether its policy allows it for that row — one projection per policy (`gate.withAbilities`). */
  async #abilities(actions: View['actions'], rows: readonly Row[]): Promise<Record<string, boolean>[]> {
    const can: Record<string, boolean>[] = rows.map(() => ({}));
    const byPolicy = new Map<PolicyClass, { abilities: Set<string>; names: [string, string][] }>();
    for (const [name, entry] of actions) {
      if (!entry.authorization) {
        for (const answer of can) answer[name] = true;
        continue;
      }
      const group = byPolicy.get(entry.authorization.policy) ?? { abilities: new Set(), names: [] };
      group.abilities.add(entry.authorization.ability);
      group.names.push([name, entry.authorization.ability]);
      byPolicy.set(entry.authorization.policy, group);
    }
    if (rows.length === 0) return can;
    for (const [policy, { abilities, names }] of byPolicy) {
      const answers = (await this.#gate().withAbilities(rows as never[], policy as PolicyClass<any>, [...abilities] as never)) as unknown as { can: Record<string, boolean> }[];
      answers.forEach((answer, index) => {
        for (const [name, ability] of names) can[index]![name] = answer.can[ability] === true;
      });
    }
    return can;
  }

  /** The URLs of the table's endpoints for this page — from the routes `tableRoutes` registered, with the page's own parameters. */
  #endpoints(definition: TableDefinition, ctx: HttpContext, view: View) {
    const needed = view.actions.length + view.bulk.length + view.exports.length > 0;
    const routes = needed ? this.#routesOf(definition) : undefined;
    const raw = needed ? rawParams(ctx.route?.path ?? '/', new URL(ctx.request.url).pathname) : {};
    const url = (kind: TableEndpointKind, param: string, name: string) => fillPath(definition.name, routes![kind]!.path, { ...raw, [param]: name }).path;
    return {
      action: (name: string) => url('action', 'tableAction', name),
      bulk: (name: string) => url('bulk', 'tableBulk', name),
      export: (name: string, query: Readonly<Record<string, string>>) => {
        const search = new URLSearchParams(query).toString();
        return `${url('export', 'tableExport', name)}${search ? `?${search}` : ''}`;
      },
    };
  }

  #routesOf(definition: TableDefinition): Partial<Record<TableEndpointKind, RouteDefinition>> {
    const found: Partial<Record<TableEndpointKind, RouteDefinition>> = {};
    for (const route of this.#router.routes) {
      const entry = ENDPOINTS.get(route);
      if (entry?.definition !== definition) continue;
      if (found[entry.kind]) throw new Error(`Table "${definition.name}": tableRoutes() registered its endpoints twice (${found[entry.kind]!.path}, ${route.path}) — once, next to its page.`);
      found[entry.kind] = route;
    }
    if (Object.keys(found).length === 0) {
      throw new Error(`Table "${definition.name}" has actions or exports but no routes — add tableRoutes(Route, Table) to its module's routes, on the registrar of its page (with the page's middleware).`);
    }
    return found;
  }
}

// --- helpers --------------------------------------------------------------------------------------------------------------

function forbidden(): HttpError {
  return new HttpError(403, 'This action is unauthorized.', {}, { key: 'marmeon.errors.unauthorized' });
}

/** The name the key has in a row: `users.id` → `id`. */
export function keyNameOf(definition: TableDefinition): string {
  return definition.key.slice(definition.key.lastIndexOf('.') + 1);
}

/**
 * The query with the visible columns (by name) and the key selected — nothing else: a hidden column never reaches the SQL. A value the
 * base query selects itself (`withCount(…, { as })`) is in its rows already, under its name ({@link DataTables.#base} left out the hidden ones).
 */
function project(definition: TableDefinition, query: SelectQuery<any, any, any>, view: View): SelectQuery<any, any, Row> {
  const keyName = keyNameOf(definition);
  const keyCovered = view.columns.some(([alias, col]) => alias === keyName && (col.ref === definition.key || col.ref.endsWith(`.${keyName}`) || col.ref === keyName));
  const selected = selectedBy(query);
  const columns = view.columns.filter(([, col]) => !selected.has(col.ref));
  return query.select((eb) => [...columns.map(([alias, col]) => eb.ref(col.ref).as(alias)), ...(keyCovered ? [] : [eb.ref(definition.key).as(keyName)])]);
}

function selectedBy(query: SelectQuery<any, any, any>): ReadonlySet<string> {
  return selectionsOf(query).selected;
}

/** Ordered by the state's sort (NULLs last, either way — the same on SQLite and Postgres), then by the key. */
function ordered(definition: TableDefinition, query: SelectQuery<any, any, Row>, state: TableState): SelectQuery<any, any, Row> {
  const direction = state.sort?.direction ?? 'asc';
  let out = query;
  if (state.sort) {
    const ref = definition.columns[state.sort.column]!.ref;
    out = out.orderBy((eb) => eb.ref(ref), (order) => (direction === 'asc' ? order.asc() : order.desc()).nullsLast());
  }
  return out.orderBy((eb) => eb.ref(definition.key), direction);
}

/** Only the visible columns and the key, by name — whatever else a row carries (a select of the base query) stays on the server. */
function pick(row: Row, view: View, keyName: string): Row {
  const out: Row = {};
  for (const [alias] of view.columns) out[alias] = row[alias];
  out[keyName] = row[keyName];
  return out;
}

/** Whether two references name the same column: equal, or the same name where one of them leaves the table out. */
function sameColumn(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes('.') && b.includes('.')) return false;
  return a.slice(a.lastIndexOf('.') + 1) === b.slice(b.lastIndexOf('.') + 1);
}

/** The state may use only what is visible: a hidden column cannot be sorted by, a hidden filter not used, a filter value only from the request's options (400). */
async function checkState(definition: TableDefinition, state: TableState, view: View): Promise<void> {
  const keys = queryKeys(definition);
  const visible = new Set(view.columns.map(([alias]) => alias));
  if (state.sort && !visible.has(state.sort.column)) throw new HttpError(400, `${keys.sort}: the table "${definition.name}" does not sort by that.`);
  const filters = new Set(view.filters.map(([name]) => name));
  for (const name of Object.keys(state.filters)) if (!filters.has(name)) throw new HttpError(400, `${keys.filter(name)}: the table "${definition.name}" has no such filter.`);
  if (state.search && !view.columns.some(([, col]) => col.isSearchable)) throw new HttpError(400, `${keys.search}: the table "${definition.name}" has no such field.`);
  // Last, because options computed for the request may ask the database: only a value this request's list holds goes on (the
  // message names the key, never the value).
  for (const [name, value] of Object.entries(state.filters)) {
    const options = await view.options(name);
    if (options && !options.allowed.has(value)) throw new TableQueryError(`${keys.filter(name)}: one of its options.`);
  }
}

/** The page's route must parse the table's state (its query schema): the browser gets the state from the page object. */
function assertQuerySchema(definition: TableDefinition, ctx: HttpContext): void {
  const query = (ctx as { query?: unknown }).query;
  const key = queryKeys(definition).perPage;
  if (query instanceof URLSearchParams || typeof query !== 'object' || query === null || !Object.hasOwn(query, key)) {
    throw new Error(
      `Table "${definition.name}": the page's route does not parse the table's query — give its request the table's schema: ` +
        `defineRequest({ query: ${definition.name}Table.query }) or r.query({ ...${definition.name}Table.query.entries, … }) (the table's constant in place of ${definition.name}Table).`,
    );
  }
}

/** The day after `YYYY-MM-DD`. */
function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT8_MAX = 9223372036854775807n;

/**
 * A key from the browser, parsed by the table's key type — `undefined` when it is none: an integer key takes a safe integer (or its
 * digits), a `bigint` key digits within Postgres' `bigint`, a `uuid` key a UUID, a `string` key text up to 200 characters.
 */
export function parseKey(type: KeyType, value: unknown): string | number | undefined {
  const text = typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : undefined) : typeof value === 'string' ? value : undefined;
  if (text === undefined || text.length === 0 || text.length > 200) return undefined;
  switch (type) {
    case 'integer': {
      if (!/^-?\d{1,16}$/.test(text)) return undefined;
      const number = Number(text);
      return Number.isSafeInteger(number) ? number : undefined;
    }
    case 'bigint':
      return /^-?\d{1,19}$/.test(text) && BigInt(text) <= INT8_MAX && BigInt(text) >= -INT8_MAX - 1n ? String(BigInt(text)) : undefined;
    case 'uuid':
      return UUID.test(text) ? text.toLowerCase() : undefined;
    case 'string':
      return text;
  }
}

function bulkBody(max: number) {
  // "All matching" first: a form without JavaScript posts its checked keys along with `all=1` — all means all.
  return v.union([
    v.object({
      all: v.union([v.literal(true), v.literal('1'), v.literal('true')]),
      query: v.optional(v.record(v.pipe(v.string(), v.maxLength(200)), v.pipe(v.string(), v.maxLength(2048)))),
      input: v.optional(v.unknown()),
    }),
    v.object({ keys: v.pipe(v.array(RowKey), v.minLength(1), v.maxLength(max, `At most ${max} rows at once.`)), input: v.optional(v.unknown()) }),
  ]);
}

async function parseBody<S extends v.GenericSchema>(schema: S, ctx: HttpContext): Promise<v.InferOutput<S>> {
  const input = await ctx.input();
  const result = v.safeParse(schema, input);
  if (!result.success) throw ValidationError.fromIssues(result.issues as never, {});
  return result.output;
}

/**
 * The handler's own answer (data, a redirect, a response) — or the counts: as JSON for an action (`x-marmeon-action`, what `useAction`
 * and `useTable` send) and an API client; for a form posted without JavaScript or a page visit, back to the page (303) — it shows the
 * table as it is now.
 */
function answer(ctx: HttpContext, result: unknown, counts: Omit<TableActionResult, 'data'>): unknown {
  if (result instanceof Response || isRedirectResult(result) || isJsonResult(result)) return result;
  const headers = ctx.request.headers;
  const wantsJson = headers.get(ACTION_HEADER) !== null || (expectsJson(ctx.request) && headers.get(PAGE_HEADER) === null);
  // Redirect or JSON depends on these request headers: a shared cache must not hand one variant to the other client.
  const vary = addVary(undefined, [...EXPECTS_JSON_VARY, ACTION_HEADER, PAGE_HEADER]);
  if (!wantsJson) return new RedirectResult().back('/').header('vary', vary.vary);
  const payload: TableActionResult = result === undefined ? counts : { ...counts, data: result };
  // About this user's rows: never cached, also when it is no action request (an API client, a test).
  return json(payload, { headers: { 'cache-control': 'no-store', ...vary } }) satisfies JsonResult<TableActionResult>;
}

/** The raw path parameters of a request: its route's pattern laid over its path (`/teams/:team` + `/teams/7` → `{ team: '7' }`). */
function rawParams(pattern: string, pathname: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(matchParams(pattern, pathname) ?? {})) params[name] = decodeURIComponent(value);
  return params;
}

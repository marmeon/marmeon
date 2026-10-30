import { Controller } from '@marmeon/http';
import type { AnyMiddleware, HttpContext, MiddlewareLike, Route, RouteAttachment, RouteDefinition } from '@marmeon/router';
import { isEveryone, routeAccess } from '@marmeon/router/internal';
import type { TableDefinition } from './define.ts';
import { endpointOf, recordEndpoint, recordPage, DataTables, type TableEndpointKind } from './tables.ts';

/** `POST …/_tables/<name>/actions/:tableAction` — a row action (`{ key }`). */
export class TableActionController extends Controller {
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  handle(ctx: HttpContext<{}, { tableAction: string }>) {
    return this.#tables.runAction(endpointOf(ctx.route).definition, ctx.params.tableAction, ctx as unknown as HttpContext);
  }
}

/** `POST …/_tables/<name>/bulk/:tableBulk` — a bulk action (`{ keys }` or `{ all: true, query }`). */
export class TableBulkController extends Controller {
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  handle(ctx: HttpContext<{}, { tableBulk: string }>) {
    return this.#tables.runBulk(endpointOf(ctx.route).definition, ctx.params.tableBulk, ctx as unknown as HttpContext);
  }
}

/** `GET …/_tables/<name>/export/:tableExport` — an export (the table's state in the query). */
export class TableExportController extends Controller {
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  handle(ctx: HttpContext<{}, { tableExport: string }>) {
    return this.#tables.export(endpointOf(ctx.route).definition, ctx.params.tableExport, ctx as unknown as HttpContext);
  }
}

/** Middleware for one kind of a table's endpoints, on top of the page's and `TableEndpointsOptions.middleware`. */
export interface EndpointOptions {
  /**
   * Runs after the page's middleware (and the `middleware` of all three kinds), in this order, before the endpoint's own checks and
   * the controller. Like any route middleware it runs before the route bindings and the page's `authorize()`: `ctx.params` are still
   * strings and the request is not yet authorized. It may need only what the page's registrar has added to the context.
   */
  readonly middleware: readonly AnyMiddleware[];
}

/**
 * What `endpoints()` takes: middleware for all of a table's endpoints, and for the export, the bulk and the row action endpoints
 * alone. See docs/tables.md#middleware-per-endpoint.
 */
export interface TableEndpointsOptions {
  /** Runs on the action, bulk and export endpoints, after the page's middleware and before the middleware of the kind. */
  readonly middleware?: readonly AnyMiddleware[];
  readonly export?: EndpointOptions;
  readonly bulk?: EndpointOptions;
  readonly action?: EndpointOptions;
}

/** The middleware the options list, by what each one needs of the context: the page's route has to provide the union of them. */
type RequiresOf<O> = UnionToIntersection<MiddlewareRequires<ListedMiddleware<O>>>;

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

type MiddlewareRequires<M> = M extends MiddlewareLike<infer R, any> ? R : never;

type ListedMiddleware<O> =
  | (O extends { readonly middleware: readonly (infer M)[] } ? M : never)
  | (O extends { readonly export: { readonly middleware: readonly (infer M)[] } } ? M : never)
  | (O extends { readonly bulk: { readonly middleware: readonly (infer M)[] } } ? M : never)
  | (O extends { readonly action: { readonly middleware: readonly (infer M)[] } } ? M : never);

/** `O` itself; an option the table does not know turns into `never`, since a generic `O` skips the check for excess properties. */
export type KnownOptions<O> = { readonly [K in keyof O]: K extends keyof TableEndpointsOptions ? O[K] : never };

/**
 * What the page's context has to hold for a table's endpoints: what its query needs, and what the listed middleware reads.
 */
type TableNeeds<Ctx, O> = (unknown extends Ctx ? {} : Ctx) & (unknown extends RequiresOf<O> ? {} : RequiresOf<O>) & object;

/**
 * A table's endpoints, ready for `RouteDefinition.attach()`: `Route.get('/members', MembersPage).attach(MembersTable.endpoints())`.
 * Made by the table's `endpoints()`. See docs/tables.md#the-controller-and-the-routes.
 */
export interface TableEndpoints<Ctx = any, O = {}> extends RouteAttachment<TableNeeds<Ctx, O>> {}

const OPTION_KEYS: readonly string[] = ['middleware', 'export', 'bulk', 'action'];

/** The routes with a list of middleware appended — after the page's own, so it adds to the page's protection and never replaces it. */
function withMiddleware(routes: Route, list: readonly AnyMiddleware[] | undefined): Route {
  if (list === undefined) return routes;
  return list.reduce<Route>((chain, layer) => chain.middleware(layer as never) as unknown as Route, routes);
}

/** A copy of a list of middleware from the options, or the error that names the option that is none. */
function middlewareList(table: string, option: string, value: unknown): readonly AnyMiddleware[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${table}.endpoints(): options.${option} must be a list of middleware.`);
  return [...(value as AnyMiddleware[])];
}

/** @internal — what a table's `endpoints()` returns. */
export function tableAttachment(definition: TableDefinition, options: TableEndpointsOptions | undefined): TableEndpoints {
  const name = definition.name;
  for (const key of Object.keys(options ?? {})) {
    if (!OPTION_KEYS.includes(key)) throw new TypeError(`${name}.endpoints(): unknown option '${key}' — the options are ${OPTION_KEYS.join(', ')}.`);
  }
  const shared = middlewareList(name, 'middleware', options?.middleware);
  // A kind that is given has to carry a list: `export: {}` or a misspelt key would leave its endpoints without the middleware meant for them.
  const ownList = (kind: TableEndpointKind) => {
    const given: unknown = options?.[kind];
    if (given === undefined) return undefined;
    return middlewareList(name, `${kind}.middleware`, typeof given === 'object' && given !== null ? (given as { middleware?: unknown }).middleware ?? null : null);
  };
  const own: Record<TableEndpointKind, readonly AnyMiddleware[] | undefined> = { action: ownList('action'), bulk: ownList('bulk'), export: ownList('export') };
  const base = `/_tables/${name}`;
  const attachTo = (routes: Route<any, any, any>, page: RouteDefinition): void => {
    const on = (kind: TableEndpointKind) => withMiddleware(withMiddleware(routes as Route, shared), own[kind]);
    const made: Partial<Record<TableEndpointKind, RouteDefinition>> = {};
    // Only the kinds the table has: a table without an export has no export route, and its URL is a 404.
    if (Object.keys(definition.actions).length > 0) made.action = on('action').post(`${base}/actions/:tableAction`, TableActionController as never);
    if (Object.keys(definition.bulk).length > 0) made.bulk = on('bulk').post(`${base}/bulk/:tableBulk`, TableBulkController as never);
    if (Object.keys(definition.exports).length > 0) made.export = on('export').get(`${base}/export/:tableExport`, TableExportController as never);
    for (const route of Object.values(made)) assertOnPage(route, page, name);
    for (const [kind, route] of Object.entries(made) as [TableEndpointKind, RouteDefinition][]) recordEndpoint(route, definition, kind);
    recordPage(page, definition, made);
    const first = made.action ?? made.bulk ?? made.export;
    if (first) openAccess(first.checks, definition);
  };
  return Object.freeze({ attachTo });
}

/** Bindings are copied when a route is made, so they are compared by what they hold: the same keys, each value `===` (the `with` list element-wise). */
function startsWithBindings(own: readonly object[], expected: readonly object[]): boolean {
  const same = (a: unknown, b: unknown): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((entry, index) => entry === b[index]) : a === b);
  return expected.every((binding, index) => {
    const mine = own[index] as Record<string, unknown> | undefined;
    const keys = Object.keys(binding);
    return mine !== undefined && keys.length === Object.keys(mine).length && keys.every((key) => key in mine && same(mine[key], (binding as Record<string, unknown>)[key]));
  });
}

/**
 * Refuses an endpoint that does not carry the page's whole access — made by calling `attachTo` by hand on some other registrar
 * instead of through `attach()`. Nothing is recorded for it, so no page links it.
 */
function assertOnPage(route: RouteDefinition, page: RouteDefinition, table: string): void {
  const access = routeAccess(page);
  const prefix = page.path === '/' ? '/' : `${page.path}/`;
  const starts = (own: readonly unknown[], expected: readonly unknown[]) => expected.every((entry, index) => own[index] === entry);
  if (
    route.group !== page.group ||
    !route.path.startsWith(prefix) ||
    !starts(route.checks, access) ||
    !starts(route.middleware, page.middleware) ||
    !startsWithBindings(route.bindings, page.bindings) ||
    !starts(route.afterAuthorize, page.afterAuthorize)
  ) {
    throw new Error(`${table}.endpoints() hangs on a page with attach(): ${route.path} does not carry the middleware, bindings, checks, path and group of ${page.path}. See docs/tables.md#the-controller-and-the-routes.`);
  }
}

/**
 * When everything the page checks is `everyone`, nothing decides who may act on a row key sent in a request body — and the
 * router cannot see keys in a body. So each action, bulk action and export then has to decide for itself. A `can(…)` or other check
 * on the route, or an `authorize` in the page's request, is such a decision: the endpoints carry it.
 */
function openAccess(checks: readonly unknown[], definition: TableDefinition): void {
  if (checks.length === 0 || !checks.every((check) => isEveryone(check as never))) return;
  const open = [
    ...Object.entries(definition.actions).filter(([, entry]) => entry.authorization === undefined).map(([name]) => `action '${name}'`),
    ...Object.entries(definition.bulk).filter(([, entry]) => entry.authorization === undefined).map(([name]) => `bulk action '${name}'`),
    ...Object.entries(definition.exports).filter(([, entry]) => entry.visibility === undefined).map(([name]) => `export '${name}'`),
  ];
  if (open.length === 0) return;
  throw new Error(
    `${definition.name}.endpoints(): the page lets everyone call it, and ${open.join(', ')} ${open.length === 1 ? 'has' : 'have'} no .authorize() — anyone who sees the table could act on any key they send. ` +
      "Add .authorize(Policy, 'ability') to each, or decide the page with authorize(can(…)) on its route or in its request. See docs/tables.md#the-security-model.",
  );
}

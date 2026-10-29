import { Controller } from '@marmeon/http';
import type { HttpContext, MiddlewareLike, Route } from '@marmeon/router';
import { isEveryone } from '@marmeon/router/internal';
import type { DataTable } from './define.ts';
import { endpointOf, recordEndpoint, DataTables } from './tables.ts';

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

/** The context the routes of registrar `R` give their controllers. */
type RegistrarContext<R> = R extends Route<infer TState, infer TParams, infer TBindings> ? Omit<HttpContext<TState, Omit<TParams, keyof TBindings> & TBindings>, 'query'> : never;

/** `T` when the registrar's routes give its query what it needs; otherwise the message. */
type CheckRegistrar<R, T> = T extends DataTable<any, infer Ctx> ? (RegistrarContext<R> extends Ctx ? T : { readonly 'the table needs more of the request than these routes have — register them on the registrar of its page, after its middleware (authenticate(), …)': Ctx }) : T;

/** The context state the routes of registrar `R` have built when an endpoint's middleware runs. */
type StateOf<R> = R extends Route<infer TState, any, any> ? (TState extends object ? TState : {}) : {};

/** Middleware for one kind of a table's endpoints, on top of the registrar's. */
export interface EndpointOptions<S extends object = {}> {
  /**
   * Runs after the registrar's middleware, in this order, before the endpoint's own checks and the controller. Like any route
   * middleware it runs before the route bindings and the registrar's `authorize()`: `ctx.params` are still strings and the request
   * is not yet authorized. It may need only what the registrar's middleware has added to the context.
   */
  readonly middleware: readonly MiddlewareLike<S, any>[];
}

/** What `tableRoutes()` takes besides the table: middleware for the export, the bulk and the row action endpoints. */
export interface TableRoutesOptions<S extends object = {}> {
  readonly export?: EndpointOptions<S>;
  readonly bulk?: EndpointOptions<S>;
  readonly action?: EndpointOptions<S>;
}

const OPTION_KEYS: readonly string[] = ['export', 'bulk', 'action'];

/** The registrar with an endpoint's middleware appended — after the registrar's own, so it adds to the page's protection and never replaces it. */
function withMiddleware(registrar: Route, endpoint: EndpointOptions<any> | undefined, kind: string, table: string): Route {
  if (endpoint === undefined) return registrar;
  if (!Array.isArray(endpoint.middleware)) throw new TypeError(`tableRoutes(${table}): options.${kind}.middleware must be a list of middleware.`);
  return endpoint.middleware.reduce<Route>((chain, layer) => chain.middleware(layer as never) as unknown as Route, registrar);
}

/**
 * Registers a table's endpoints **on the registrar of its page**, so they run the same middleware, route bindings and group as the
 * page — but not the page controller's `authorize`: a table that needs one says so itself (`defineTable({ authorize })`). A
 * registrar whose routes lack what the table's query needs is a compile error. A table on several pages is registered once for each, on that page's registrar: `docs/tables.md#one-table-on-several-pages`.
 *
 * `options` adds middleware to the export, bulk or action endpoints alone, such as a stricter throttle for the export. It runs after
 * the registrar's middleware and before the table's checks: `docs/tables.md#middleware-per-endpoint`.
 */
export function tableRoutes<R extends Route<any, any, any>, T extends DataTable>(Route: R, table: T & CheckRegistrar<R, T>, options?: TableRoutesOptions<StateOf<R>>): void {
  const { definition } = table;
  for (const key of Object.keys(options ?? {})) {
    if (!OPTION_KEYS.includes(key)) throw new TypeError(`tableRoutes(${definition.name}): unknown option '${key}' — the options are ${OPTION_KEYS.join(', ')}.`);
  }
  const base = `/_tables/${definition.name}`;
  const registrar = Route as unknown as Route;
  const action = withMiddleware(registrar, options?.action, 'action', definition.name).post(`${base}/actions/:tableAction`, TableActionController as never);
  recordEndpoint(action, definition, 'action');
  const bulk = withMiddleware(registrar, options?.bulk, 'bulk', definition.name).post(`${base}/bulk/:tableBulk`, TableBulkController as never);
  recordEndpoint(bulk, definition, 'bulk');
  const download = withMiddleware(registrar, options?.export, 'export', definition.name).get(`${base}/export/:tableExport`, TableExportController as never);
  recordEndpoint(download, definition, 'export');
  openRegistrar(action.checks, definition);
}

/**
 * When everything the registrar checks is `everyone`, nothing decides who may act on a row key sent in a request body — and the
 * router cannot see keys in a body. So each action, bulk action and export then has to decide for itself.
 */
function openRegistrar(checks: readonly unknown[], definition: DataTable['definition']): void {
  if (checks.length === 0 || !checks.every((check) => isEveryone(check as never))) return;
  const open = [
    ...Object.entries(definition.actions).filter(([, entry]) => entry.authorization === undefined).map(([name]) => `action '${name}'`),
    ...Object.entries(definition.bulk).filter(([, entry]) => entry.authorization === undefined).map(([name]) => `bulk action '${name}'`),
    ...Object.entries(definition.exports).filter(([, entry]) => entry.visibility === undefined).map(([name]) => `export '${name}'`),
  ];
  if (open.length === 0) return;
  throw new Error(
    `tableRoutes(${definition.name}): its registrar lets everyone call it, and ${open.join(', ')} ${open.length === 1 ? 'has' : 'have'} no .authorize() — anyone who sees the table could act on any key they send. ` +
      "Add .authorize(Policy, 'ability') to each, or decide the registrar with Route.authorize(can(…)). See docs/tables.md#the-security-model.",
  );
}

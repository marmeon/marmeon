import { Controller } from '@marmeon/http';
import type { HttpContext, Route } from '@marmeon/router';
import type { Table } from './define.ts';
import { endpointOf, recordEndpoint, Tables } from './tables.ts';

/** `POST …/_tables/<name>/actions/:tableAction` — a row action (`{ key }`). */
export class TableActionController extends Controller {
  readonly #tables: Tables;

  constructor(tables: Tables) {
    super();
    this.#tables = tables;
  }

  handle(ctx: HttpContext<{}, { tableAction: string }>) {
    return this.#tables.runAction(endpointOf(ctx.route).definition, ctx.params.tableAction, ctx as unknown as HttpContext);
  }
}

/** `POST …/_tables/<name>/bulk/:tableBulk` — a bulk action (`{ keys }` or `{ all: true, query }`). */
export class TableBulkController extends Controller {
  readonly #tables: Tables;

  constructor(tables: Tables) {
    super();
    this.#tables = tables;
  }

  handle(ctx: HttpContext<{}, { tableBulk: string }>) {
    return this.#tables.runBulk(endpointOf(ctx.route).definition, ctx.params.tableBulk, ctx as unknown as HttpContext);
  }
}

/** `GET …/_tables/<name>/export/:tableExport` — an export (the table's state in the query). */
export class TableExportController extends Controller {
  readonly #tables: Tables;

  constructor(tables: Tables) {
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
type CheckRegistrar<R, T> = T extends Table<any, infer Ctx> ? (RegistrarContext<R> extends Ctx ? T : { readonly 'the table needs more of the request than these routes have — register them on the registrar of its page, after its middleware (authenticate(), …)': Ctx }) : T;

/**
 * Registers a table's endpoints **on the registrar of its page** — so they run the same middleware (authentication, `verified()`,
 * the tenant, rate limits), the same route bindings and the same group (`web`: sessions, CSRF on the POSTs, E143) as the page:
 *
 * ```ts
 * const members = Route.prefix('/members').middleware(authenticate()).middleware(verified());
 * members.get('/', ListMembersController).name('members.index');
 * tableRoutes(members, MembersTable);
 * //   POST /members/_tables/members/actions/:tableAction   a row action  ({ key })
 * //   POST /members/_tables/members/bulk/:tableBulk        a bulk action ({ keys } | { all: true, query })
 * //   GET  /members/_tables/members/export/:tableExport    an export     (?sort=…&filter[…]=…)
 * ```
 *
 * Not the page controller's `authorize`: a table that needs one says so itself (`defineTable({ authorize })` — checked on the page
 * and in every endpoint). A registrar whose routes lack what the table's query needs (`ctx.user` without `authenticate()`) is a
 * compile error. The routes have no names: the page's prop carries their URLs (with the page's own path parameters filled in).
 */
export function tableRoutes<R extends Route<any, any, any>, T extends Table>(Route: R, table: T & CheckRegistrar<R, T>): void {
  const { definition } = table;
  const base = `/_tables/${definition.name}`;
  const registrar = Route as unknown as Route;
  recordEndpoint(registrar.post(`${base}/actions/:tableAction`, TableActionController as never), definition, 'action');
  recordEndpoint(registrar.post(`${base}/bulk/:tableBulk`, TableBulkController as never), definition, 'bulk');
  recordEndpoint(registrar.get(`${base}/export/:tableExport`, TableExportController as never), definition, 'export');
}

import { Controller } from '@marmeon/http';
import type { HttpContext, Route } from '@marmeon/router';
import { isEveryone } from '@marmeon/router/internal';
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
 * Registers a table's endpoints **on the registrar of its page**, so they run the same middleware, route bindings and group as the
 * page — but not the page controller's `authorize`: a table that needs one says so itself (`defineTable({ authorize })`). A
 * registrar whose routes lack what the table's query needs is a compile error. See `docs/tables.md#the-controller-and-the-routes`.
 */
export function tableRoutes<R extends Route<any, any, any>, T extends Table>(Route: R, table: T & CheckRegistrar<R, T>): void {
  const { definition } = table;
  const base = `/_tables/${definition.name}`;
  const registrar = Route as unknown as Route;
  const action = registrar.post(`${base}/actions/:tableAction`, TableActionController as never);
  recordEndpoint(action, definition, 'action');
  recordEndpoint(registrar.post(`${base}/bulk/:tableBulk`, TableBulkController as never), definition, 'bulk');
  recordEndpoint(registrar.get(`${base}/export/:tableExport`, TableExportController as never), definition, 'export');
  openRegistrar(action.checks, definition);
}

/**
 * When everything the registrar checks is `everyone`, nothing decides who may act on a row key sent in a request body — and the
 * router cannot see keys in a body. So each action, bulk action and export then has to decide for itself.
 */
function openRegistrar(checks: readonly unknown[], definition: Table['definition']): void {
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

import { Router, type RouteDefinition } from '@marmeon/router';
import type { DataTable } from '../index.ts';
import { openRoutes } from './open-routes.ts';

/**
 * The route of a page `table` is attached to, as the router has it: the `route` of a context for tests that call
 * `DataTables.resolve()` without the HTTP stack.
 */
export function pageOf(table: DataTable, path = '/x'): RouteDefinition {
  const router = new Router().load(openRoutes((Route) => void Route.get(path, () => 'page').attach(table.endpoints() as never)));
  return router.routes.find((route) => route.path === path)!;
}

import { Router, type AnyAction, type AnyMiddleware, type RouteDefinition } from '@marmeon/router';
import { accessLabel, isMiddlewareClass, routeAccess } from '@marmeon/router/internal';
import type { CommandInput } from '../command.ts';

/** Prints every registered route as a table: methods, path, name, group, middleware in execution order, who may call it, action. */
export class RouteListCommand {
  static command = 'route:list';
  static description = 'List all registered routes';

  readonly #router: Router;

  constructor(router: Router) {
    this.#router = router;
  }

  handle({ output }: CommandInput): void {
    // Middleware in execution order: global, the route's group, its own.
    const rows = this.#router.routes.map((route) => [
      route.methods.join('|'),
      route.path,
      route.routeName ?? '',
      route.group ?? '',
      this.#router.middlewareFor(route).map(middlewareName).join(', '),
      this.#access(route),
      actionName(route.action),
    ]);
    output.table(['METHOD', 'PATH', 'NAME', 'GROUP', 'MIDDLEWARE', 'ACCESS', 'ACTION'], rows);
    output.line();
    output.line(`${rows.length} routes`);
  }

  // The framework's own routes decide for themselves (signatures, their own checks), so they say so instead of `none`.
  #access(route: RouteDefinition): string {
    if (this.#router.isFrameworkRoute(route)) return 'framework';
    const checks = routeAccess(route);
    return checks.length === 0 ? 'none' : checks.map(accessLabel).join(' + ');
  }
}

function middlewareName(middleware: AnyMiddleware): string {
  return isMiddlewareClass(middleware) ? middleware.name : middleware.name || 'anonymous';
}

function actionName(action: AnyAction): string {
  return typeof action.prototype?.handle === 'function' ? action.name : 'Closure';
}

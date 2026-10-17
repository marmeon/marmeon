import { Router, type AnyAction, type AnyMiddleware, type RouteDefinition } from '@marmeon/router';
import { accessLabel, isMiddlewareClass, routeAccess } from '@marmeon/router/internal';
import type { CommandInput } from '../command.ts';

/** Prints every registered route as a table: methods, path, name, group, middleware in execution order, who may call it, action. */
export class RouteListCommand {
  static command = 'route:list';
  static description = 'List all registered routes';
  static options = { json: { type: 'boolean' } } as const;

  readonly #router: Router;

  constructor(router: Router) {
    this.#router = router;
  }

  handle({ options, output }: CommandInput): void {
    if (options.json === true) {
      output.json({
        format: 1,
        routes: this.#router.routes.map((route) => ({
          methods: [...route.methods],
          path: route.path,
          name: route.routeName ?? null,
          group: route.group ?? null,
          middleware: this.#router.middlewareFor(route).map(middlewareName),
          access: this.#accessList(route),
          action: actionName(route.action),
        })),
        warnings: [],
      });
      return;
    }
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
  // `framework` and `none` stand alone; otherwise one label per check.
  #accessList(route: RouteDefinition): string[] | 'framework' | 'none' {
    if (this.#router.isFrameworkRoute(route)) return 'framework';
    const checks = routeAccess(route);
    return checks.length === 0 ? 'none' : checks.map(accessLabel);
  }

  // The table joins the labels with `+`.
  #access(route: RouteDefinition): string {
    const list = this.#accessList(route);
    return typeof list === 'string' ? list : list.join(' + ');
  }
}

function middlewareName(middleware: AnyMiddleware): string {
  return isMiddlewareClass(middleware) ? middleware.name : middleware.name || 'anonymous';
}

function actionName(action: AnyAction): string {
  return typeof action.prototype?.handle === 'function' ? action.name : 'Closure';
}

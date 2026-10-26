import { Router, type AnyAction, type AnyMiddleware, type RouteDefinition } from '@marmeon/router';
import { accessLabel, isMiddlewareClass, routeAccess } from '@marmeon/router/internal';
import type { CommandInput } from '../command.ts';

/** Prints every registered route as a table: methods, path, name, group, middleware in execution order, who may call it, action. */
export class RouteListCommand {
  static command = 'route:list';
  static description = 'List all registered routes';
  static usage = '[--json]';
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
          publicBindings: publicBindings(route),
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

  // The table joins the labels with `+` and names the parameters whose records are public.
  #access(route: RouteDefinition): string {
    const list = this.#accessList(route);
    const checks = typeof list === 'string' ? list : list.join(' + ');
    const open = publicBindings(route);
    return open.length === 0 ? checks : `${checks} (public: ${open.join(', ')})`;
  }
}

/** The parameters whose records `bind(…, { public: true })` makes findable by anyone who may call the route. */
function publicBindings(route: RouteDefinition): string[] {
  return route.bindings.filter((binding) => binding.public === true).map((binding) => binding.param);
}

function middlewareName(middleware: AnyMiddleware): string {
  return isMiddlewareClass(middleware) ? middleware.name : middleware.name || 'anonymous';
}

function actionName(action: AnyAction): string {
  return typeof action.prototype?.handle === 'function' ? action.name : 'Closure';
}

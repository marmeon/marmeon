import { Router, type AnyAction, type AnyMiddleware, type RouteDefinition } from '@marmeon/router';
import { accessLabel, isIslandAction, isMiddlewareClass, routeAccess } from '@marmeon/router/internal';
import type { CommandInput } from '../command.ts';

/** Prints every registered route as a table: methods, path, name, group, middleware in execution order, who may call it, action (marked `(island)` for a route that answers an island's request, `(fallback)` for a `Route.fallback()`, listed last: it answers what no other route takes). */
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
        routes: this.#routes().map((route) => ({
          methods: [...route.methods],
          path: route.path,
          name: route.routeName ?? null,
          group: route.group ?? null,
          middleware: this.#router.middlewareFor(route).map(middlewareName),
          access: this.#accessList(route),
          publicBindings: publicBindings(route),
          action: actionName(route.action),
          island: isIslandAction(route.action),
          fallback: this.#router.isFallback(route),
        })),
        warnings: [],
      });
      return;
    }
    // Middleware in execution order: global, the route's group, its own.
    const rows = this.#routes().map((route) => [
      route.methods.join('|'),
      route.path,
      route.routeName ?? '',
      route.group ?? '',
      this.#router.middlewareFor(route).map(middlewareName).join(', '),
      this.#access(route),
      this.#action(route),
    ]);
    output.table(['METHOD', 'PATH', 'NAME', 'GROUP', 'MIDDLEWARE', 'ACCESS', 'ACTION'], rows);
    output.line();
    output.line(`${rows.length} routes`);
  }

  // The fallbacks last, the longest prefix first: the order the server registers them, after every other route.
  #routes(): readonly RouteDefinition[] {
    return [...this.#router.routes.filter((route) => !this.#router.isFallback(route)), ...this.#router.fallbacks];
  }

  #action(route: RouteDefinition): string {
    if (isIslandAction(route.action)) return `${actionName(route.action)} (island)`;
    return this.#router.isFallback(route) ? `${actionName(route.action)} (fallback)` : actionName(route.action);
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

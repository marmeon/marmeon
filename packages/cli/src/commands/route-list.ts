import { isMiddlewareClass, Router, type AnyAction, type AnyMiddleware } from '@bespokecore/router';
import type { CommandInput } from '../command.ts';

/** Laravel's `route:list`. */
export class RouteListCommand {
  static command = 'route:list';
  static description = 'List all registered routes';

  readonly #router: Router;

  constructor(router: Router) {
    this.#router = router;
  }

  handle({ output }: CommandInput): void {
    const rows = this.#router.routes.map((route) => [
      route.methods.join('|'),
      route.path,
      route.routeName ?? '',
      route.middleware.map(middlewareName).join(', '),
      actionName(route.action),
    ]);
    output.table(['METHOD', 'PATH', 'NAME', 'MIDDLEWARE', 'ACTION'], rows);
    output.line();
    output.line(`${rows.length} routes`);
  }
}

function middlewareName(middleware: AnyMiddleware): string {
  return isMiddlewareClass(middleware) ? middleware.name : middleware.name || 'anonymous';
}

function actionName(action: AnyAction): string {
  return typeof action.prototype?.handle === 'function' ? action.name : 'Closure';
}

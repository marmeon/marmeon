import { runPipeline } from './middleware.ts';
import { Route } from './route.ts';
import type { RouteDefinition } from './route-definition.ts';
import type { AnyAction, ControllerClass, HttpContext } from './types.ts';

/** A module's route file. Nothing is registered until a `Router` loads it. */
export interface RouteDefinitions {
  readonly register: (Route: Route) => void;
}

/**
 * Declares a route file without touching global state, so re-importing it
 * (tests, Vite HMR) never registers routes twice.
 *
 * ```ts
 * export default defineRoutes((Route) => {
 *   Route.get('/', [HomeController, 'index']).name('home');
 * });
 * ```
 */
export function defineRoutes(register: (Route: Route) => void): RouteDefinitions {
  return { register };
}

export interface RouterOptions {
  /** Hook for a DI container. Defaults to `new Controller()`. */
  resolveController?: (controller: ControllerClass) => unknown;
}

export interface DispatchInput {
  request: Request;
  params: Record<string, string>;
}

export type ResponseFactory = (result: unknown, ctx: HttpContext) => Response | Promise<Response>;

/** Laravel's `Router::toResponse` in miniature: strings become HTML, everything else JSON. */
export const defaultToResponse: ResponseFactory = (result) => {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return new Response(null, { status: 204 });
  if (typeof result === 'string') {
    return new Response(result, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return Response.json(result);
};

export class Router {
  readonly #routes: RouteDefinition[] = [];
  readonly #resolveController: (controller: ControllerClass) => unknown;

  constructor(options: RouterOptions = {}) {
    this.#resolveController = options.resolveController ?? ((Controller) => new Controller());
  }

  get routes(): readonly RouteDefinition[] {
    return this.#routes;
  }

  load(...definitions: RouteDefinitions[]): this {
    const root = new Route((route) => this.#routes.push(route));
    for (const definition of definitions) definition.register(root);
    return this;
  }

  findByName(name: string): RouteDefinition | undefined {
    return this.#routes.find((route) => route.routeName === name);
  }

  /** Builds a URL for a named route, like Laravel's `route('profile.show', { id: 1 })`. */
  url(name: string, params: Record<string, string | number> = {}): string {
    const route = this.findByName(name);
    if (!route) throw new Error(`Route [${name}] is not defined.`);

    const path = route.path.replace(/\/:(\w+)(\{[^}]*\})?(\?)?/g, (_match, key: string, _pattern, optional?: string) => {
      const value = params[key];
      if (value === undefined) {
        if (optional) return '';
        throw new Error(`Missing required parameter [${key}] for route [${name}].`);
      }
      return `/${encodeURIComponent(String(value))}`;
    });

    return path || '/';
  }

  /** Runs a matched route through its middleware pipeline and action. */
  dispatch(route: RouteDefinition, input: DispatchInput, toResponse: ResponseFactory = defaultToResponse): Promise<Response> {
    const ctx: HttpContext = { request: input.request, params: input.params, route };

    return runPipeline(ctx, route.middleware, async (finalCtx) => {
      const result = await this.#invoke(route.action, finalCtx);
      return toResponse(result, finalCtx);
    });
  }

  #invoke(action: AnyAction, ctx: HttpContext): unknown {
    if (typeof action === 'function') return action(ctx);

    const [Controller, method] = action;
    const controller = this.#resolveController(Controller) as Record<string, unknown>;
    const handler = controller[method];
    if (typeof handler !== 'function') {
      throw new TypeError(`Method [${Controller.name}::${method}] does not exist.`);
    }
    return handler.call(controller, ctx);
  }
}

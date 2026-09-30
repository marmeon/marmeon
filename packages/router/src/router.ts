import { runPipeline } from './middleware.ts';
import { Route } from './route.ts';
import type { RouteDefinition } from './route-definition.ts';
import type { AnyAction, ControllerClass, HttpContext, Invokable } from './types.ts';

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
  resolveController?: ControllerResolver;
}

export interface DispatchInput {
  request: Request;
  params: Record<string, string>;
}

export type ResponseFactory = (result: unknown, ctx: HttpContext) => Response | Promise<Response>;

export type ControllerResolver = (controller: ControllerClass) => Invokable<HttpContext>;

export interface DispatchOptions {
  toResponse?: ResponseFactory;
  /** Per-request controller resolution, e.g. from a request-scoped container. */
  resolveController?: ControllerResolver;
}

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
  readonly #resolveController: ControllerResolver;

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
  dispatch(route: RouteDefinition, input: DispatchInput, options: DispatchOptions = {}): Promise<Response> {
    const ctx: HttpContext = { request: input.request, params: input.params, route };
    const toResponse = options.toResponse ?? defaultToResponse;
    const resolveController = options.resolveController ?? this.#resolveController;

    return runPipeline(ctx, route.middleware, async (finalCtx) => {
      const { action } = route;
      const result = await (isControllerClass(action) ? resolveController(action).handle(finalCtx) : action(finalCtx));
      return toResponse(result, finalCtx);
    });
  }
}

/**
 * Tells invokable controllers from closures at runtime: only a class has a
 * prototype carrying `handle` (arrow functions have no prototype at all).
 */
export function isControllerClass(action: AnyAction): action is ControllerClass {
  return typeof action.prototype?.handle === 'function';
}

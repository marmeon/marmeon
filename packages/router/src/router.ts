import { runPipeline } from './middleware.ts';
import { Route } from './route.ts';
import type { RouteDefinition } from './route-definition.ts';
import type { AnyAction, ClassResolver, ControllerClass, HttpContext } from './types.ts';

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
  /** Default class resolution when `dispatch` gets none. Defaults to `new Class()`. */
  resolve?: ClassResolver;
}

export interface DispatchInput {
  request: Request;
  params: Record<string, string>;
}

/** Turns a handler result into a Response. Needs only the request, so errors outside a route can use it too. */
export type ResponseFactory = (result: unknown, ctx: { readonly request: Request }) => Response | Promise<Response>;

export interface DispatchOptions {
  toResponse?: ResponseFactory;
  /** Builds controller and middleware classes for this request, e.g. from a request-scoped container. */
  resolve?: ClassResolver;
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
  readonly #resolve: ClassResolver;

  constructor(options: RouterOptions = {}) {
    this.#resolve = options.resolve ?? ((Class) => new Class());
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
    const resolve = options.resolve ?? this.#resolve;

    return runPipeline(
      ctx,
      route.middleware,
      async (finalCtx) => {
        const { action } = route;
        const result = await (isControllerClass(action) ? resolve(action).handle(finalCtx) : action(finalCtx));
        return toResponse(result, finalCtx);
      },
      resolve,
    );
  }
}

/**
 * Tells invokable controllers from closures at runtime: only a class has a
 * prototype carrying `handle` (arrow functions have no prototype at all).
 */
export function isControllerClass(action: AnyAction): action is ControllerClass {
  return typeof action.prototype?.handle === 'function';
}

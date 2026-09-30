import { HttpError } from './errors.ts';
import { runPipeline } from './middleware.ts';
import { GLOBAL, MiddlewareGroups } from './middleware-groups.ts';
import { createRequestState, type RequestState } from './request.ts';
import { validateRequest } from './request-definition.ts';
import { Route } from './route.ts';
import type { RouteDefinition } from './route-definition.ts';
import type { AnyAction, AnyMiddleware, ClassResolver, ControllerClass, HttpContext, MiddlewareHandler } from './types.ts';

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
 *   Route.get('/', ShowHomeController).name('home');
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
  /**
   * Query, input and cookies of this request. The kernel creates it, so it can add
   * queued cookies to any response — error pages included. Created here otherwise.
   */
  state?: RequestState;
  /** Collects middleware with a `terminate` hook, to run once the response is sent. */
  onTerminable?: (handler: MiddlewareHandler<any, any>, ctx: HttpContext) => void;
  /** Turns errors into responses inside the pipeline, so outer middleware still applies (see `runPipeline`). */
  onError?: (error: unknown, ctx: HttpContext) => Response | Promise<Response>;
}

export interface LoadOptions {
  /** Middleware group of these routes (`web`, `api`). */
  group?: string;
  /** Path prefix for all of them, e.g. `/api`. */
  prefix?: string;
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
  #byName = new Map<string, RouteDefinition>();
  /** Middleware groups and the global stack — packages and apps add to them while booting. */
  readonly middleware = new MiddlewareGroups();

  constructor(options: RouterOptions = {}) {
    this.#resolve = options.resolve ?? ((Class) => new Class());
  }

  get routes(): readonly RouteDefinition[] {
    return this.#routes;
  }

  load(...definitions: RouteDefinitions[]): this;
  load(options: LoadOptions, ...definitions: RouteDefinitions[]): this;
  load(...args: (LoadOptions | RouteDefinitions)[]): this {
    const [first, ...rest] = args;
    const options = first && !('register' in first) ? first : {};
    const definitions = (first && 'register' in first ? args : rest) as RouteDefinitions[];

    const root = new Route((route) => this.#routes.push(route), {
      prefix: options.prefix ?? '/',
      namePrefix: '',
      middleware: [],
      group: options.group,
    });
    for (const definition of definitions) definition.register(root);
    this.#indexNames();
    return this;
  }

  findByName(name: string): RouteDefinition | undefined {
    return this.#byName.get(name);
  }

  /**
   * Everything a route runs, in order: global middleware, its group's, then its own.
   * Listed twice (a group's and the route's), a middleware runs once, at its first place — like Laravel.
   */
  middlewareFor(route: RouteDefinition): readonly AnyMiddleware[] {
    const all = [...this.middleware.get(GLOBAL), ...(route.group ? this.middleware.get(route.group) : []), ...route.middleware];
    return [...new Set(all)];
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
    const state = options.state ?? createRequestState(input.request);
    const ctx: HttpContext = { ...state, request: input.request, params: input.params, route };
    const toResponse = options.toResponse ?? defaultToResponse;
    const resolve = options.resolve ?? this.#resolve;

    return runPipeline(
      ctx,
      this.middlewareFor(route),
      async (afterMiddleware) => {
        // Bindings after the middleware (authentication answers before a 404 could tell what exists),
        // before `authorize` (which may look at the bound record) — Laravel's middleware priority.
        const finalCtx = route.bindings.length ? { ...afterMiddleware, params: await bindParams(route, afterMiddleware, resolve) } : afterMiddleware;
        const { action } = route;
        let result: unknown;
        if (isControllerClass(action)) {
          // REPR: authorize and validate before the controller is even built.
          const handlerCtx = action.request ? { ...finalCtx, body: await validateRequest(action.request, finalCtx) } : finalCtx;
          result = await resolve(action).handle(handlerCtx);
        } else {
          result = await action(finalCtx);
        }
        return toResponse(result, finalCtx);
      },
      { resolve, onTerminable: options.onTerminable, onError: options.onError },
    );
  }

  /**
   * A request no route matched: it still passes the global middleware (security
   * headers, request logging, …), then ends in a 404.
   */
  dispatchNotFound(request: Request, options: Omit<DispatchOptions, 'toResponse'> = {}): Promise<Response> {
    const state = options.state ?? createRequestState(request);
    const ctx = { ...state, request, params: {} } as unknown as HttpContext;
    return runPipeline(
      ctx,
      this.middleware.get(GLOBAL),
      () => Promise.reject(new HttpError(404)),
      { resolve: options.resolve ?? this.#resolve, onTerminable: options.onTerminable, onError: options.onError },
    );
  }

  /** Names are an API (redirects, links): a name used twice is a boot error, not a silent overwrite. */
  #indexNames(): void {
    const byName = new Map<string, RouteDefinition>();
    for (const route of this.#routes) {
      const name = route.routeName;
      if (name === undefined) continue;
      const taken = byName.get(name);
      if (taken) {
        throw new Error(
          `Route name [${name}] is used twice: ${taken.methods.join('|')} ${taken.path} and ${route.methods.join('|')} ${route.path}.`,
        );
      }
      byName.set(name, route);
    }
    this.#byName = byName;
  }
}

/** Resolves the route's bound parameters in order — a scoped one within its already resolved parent. */
async function bindParams(route: RouteDefinition, ctx: HttpContext, resolve: ClassResolver): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { ...(ctx.params as Record<string, string>) };
  for (const binding of route.bindings) {
    const value = params[binding.param];
    if (value === undefined) continue; // an optional parameter that is absent stays absent
    const scope = binding.scopedBy
      ? { param: binding.scopedBy, parent: params[binding.scopedBy], column: binding.column ?? `${binding.scopedBy}_id` }
      : undefined;
    const bound = await resolve(binding.binder).resolveRouteBinding(String(value), { ctx, ...(scope ? { scope } : {}) });
    if (bound === undefined || bound === null) throw new HttpError(404);
    params[binding.param] = bound;
  }
  return params;
}

/**
 * Tells invokable controllers from closures at runtime: only a class has a
 * prototype carrying `handle` (arrow functions have no prototype at all).
 */
export function isControllerClass(action: AnyAction): action is ControllerClass {
  return typeof action.prototype?.handle === 'function';
}

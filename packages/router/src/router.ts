import { Redactor } from '@marmeon/core';
import { formatAccessProblems, isEveryone, isScoped, openBindings, RouteAccessError, routeAccess, type AccessProblem } from './access.ts';
import { HttpError } from './errors.ts';
import { runPipeline } from './middleware.ts';
import { GLOBAL, MiddlewareGroups } from './middleware-groups.ts';
import { createRequestState, type RequestState } from './request.ts';
import { liveValidationFields, VALIDATED_HEADER } from './live-validation.ts';
import { authorizeRequest, nothingToValidate, unauthorized, validateRequest, ValidationError, type RequestDefinition, type ValidationHook } from './request-definition.ts';
import { Route, type RegistrarAudit } from './route.ts';
import type { RouteDefinition } from './route-definition.ts';
import type { CheckRouteName, RouteArgs, RouteNameInput } from './routes.ts';
import type { AnyAction, AnyMiddleware, ClassResolver, ControllerClass, HttpContext, MiddlewareHandler } from './types.ts';
import { toSearchParams, urlFor, type Query } from './url.ts';

/** A module's route file. Nothing is registered until a `Router` loads it. */
export interface RouteDefinitions {
  readonly register: (Route: Route) => void;
}

/**
 * Declares a route file without touching global state, so re-importing it
 * (tests, Vite HMR) never registers routes twice. See docs/routing.md#route-files.
 */
export function defineRoutes(register: (Route: Route) => void): RouteDefinitions {
  return { register };
}

/**
 * A request a package answers in the route's place (`router.intercept(…)`): it runs the route's middleware, bindings and
 * `authorize` (403), then the interceptor answers; the controller is never built. @marmeon/storage answers upload targets
 * this way, so who may submit a form may upload its files.
 */
export interface RouteInterceptor {
  /** Whether this request is the interceptor's (a header it looks for). */
  claims(request: Request): boolean;
  answer(ctx: HttpContext, request: RequestDefinition | undefined, resolve: ClassResolver): Response | Promise<Response>;
}

export interface RouterOptions {
  /** Default class resolution when `dispatch` gets none. Defaults to `new Class()`. */
  resolve?: ClassResolver;
}

export interface DispatchInput {
  request: Request;
  params: Record<string, string>;
}

/**
 * The parsed query of a page's request (`defineRequest({ query })`), for the page object: the fields the URL set
 * (without defaults) and the defaults — so the browser never parses a URL itself (`useQueryState`).
 */
export interface PageQuery {
  readonly values: Readonly<Record<string, unknown>>;
  readonly defaults: Readonly<Record<string, unknown>>;
}

/** What a response factory gets besides the result: the request — and, behind a query schema, its parsed query. */
export interface ResponseContext {
  readonly request: Request;
  readonly pageQuery?: PageQuery | undefined;
}

/** Turns a handler result into a Response. Needs only the request, so errors outside a route can use it too. */
export type ResponseFactory = (result: unknown, ctx: ResponseContext) => Response | Promise<Response>;

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

/**
 * Lets `load()` take routes under `/_marmeon/`, which belong to the framework (docs/routing.md#the-frameworks-paths), and
 * exempts them from the access rule. A plain `Symbol()`, not in the registry: nothing but this module's export can make one
 * that matches, and the framework's packages reach it through `@marmeon/router/internal`, not the package's index.
 * @internal
 */
export const FRAMEWORK_ROUTES: unique symbol = Symbol('marmeon.router.framework');

/** The path prefix only routes loaded with {@link FRAMEWORK_ROUTES} may use. */
const RESERVED_PREFIX = '/_marmeon';

const isReserved = (path: string): boolean => {
  const lower = path.toLowerCase();
  return lower === RESERVED_PREFIX || lower.startsWith(`${RESERVED_PREFIX}/`);
};

export interface LoadOptions {
  /** Middleware group of these routes (`web`, `api`). */
  group?: string;
  /** Path prefix for all of them, e.g. `/api`. */
  prefix?: string;
  /** @internal */
  framework?: typeof FRAMEWORK_ROUTES;
}

/** Turns an action's result into a response: a `Response` as it is, nothing as 204, strings as HTML, everything else as JSON. */
export const defaultToResponse: ResponseFactory = (result) => {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return new Response(null, { status: 204 });
  if (typeof result === 'string') {
    return new Response(result, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return Response.json(result);
};

/** Masks secrets in the paths the router names in its errors: a webhook's token must not reach a log. */
const shown = new Redactor();
const showPath = (route: RouteDefinition): string => shown.path(route.path, route.path);

export class Router {
  readonly #routes: RouteDefinition[] = [];
  #snapshot: readonly RouteDefinition[] | undefined;
  readonly #resolve: ClassResolver;
  /** The routes loaded with {@link FRAMEWORK_ROUTES}. A private set: `RouteDefinition.reserved` is a field an app could write. */
  readonly #framework = new WeakSet<RouteDefinition>();
  /** The access problems of the routes `dispatch` has seen, so a request costs a lookup. */
  readonly #judged = new WeakMap<RouteDefinition, AccessProblem[]>();
  #byName = new Map<string, RouteDefinition>();
  /** Middleware groups and the global stack — packages and apps add to them while booting. */
  readonly middleware = new MiddlewareGroups();
  readonly #validationHooks: ValidationHook[] = [];
  readonly #interceptors: RouteInterceptor[] = [];

  constructor(options: RouterOptions = {}) {
    this.#resolve = options.resolve ?? ((Class) => new Class());
  }

  /** A frozen snapshot: pushing a route into it cannot get one past the checks made at load. */
  get routes(): readonly RouteDefinition[] {
    return (this.#snapshot ??= Object.freeze([...this.#routes]));
  }

  /**
   * The routes in the order the server registers them: the framework's paths under `/_marmeon/` first, so no parameter or
   * wildcard route of an app matches ahead of them. The order inside each group is the order of loading.
   *
   * @internal
   */
  get registrationOrder(): readonly RouteDefinition[] {
    return [...this.#routes.filter((route) => route.reserved), ...this.#routes.filter((route) => !route.reserved)];
  }

  /** Whether the route was loaded by the framework itself (`load({ framework: FRAMEWORK_ROUTES }, …)`); nothing an app sets can make it so. @internal */
  isFrameworkRoute(route: RouteDefinition): boolean {
    return this.#framework.has(route);
  }

  /**
   * The routes that do not say who may call them, and the open ones that bind a record by its key. Nothing is enforced here:
   * the kernel and the CLI refuse them. See docs/authorization.md#every-route-decides.
   *
   * @internal
   */
  accessProblems(): AccessProblem[] {
    return this.#routes.flatMap((route) => this.#problemsOf(route));
  }

  /** What `accessProblems()` says of one route; none for the framework's own. */
  #problemsOf(route: RouteDefinition): AccessProblem[] {
    if (this.#framework.has(route)) return [];
    const checks = routeAccess(route);
    if (checks.length === 0) return [{ kind: 'undecided', route }];
    if (!checks.every(isEveryone)) return [];
    const write = !route.methods.every((method) => method === 'GET' || method === 'HEAD');
    return openBindings(route).map((binding) => ({ kind: 'open-binding', route, param: binding.param, binder: binding.binder.name, write }));
  }

  load(...definitions: RouteDefinitions[]): this;
  load(options: LoadOptions, ...definitions: RouteDefinitions[]): this;
  load(...args: (LoadOptions | RouteDefinitions)[]): this {
    const [first, ...rest] = args;
    const options = first && !('register' in first) ? first : {};
    const definitions = (first && 'register' in first ? args : rest) as RouteDefinitions[];

    const audit: RegistrarAudit[] = [];
    let sealed = false;
    const root = new Route((route) => {
      // A route added once the files have run (a stored registrar, an async register function) would have skipped every check made at load.
      if (sealed) throw new Error(`A route was registered after its routes were loaded${route.site ? ` (${route.site})` : ''}: register routes synchronously, inside the defineRoutes() callback.`);
      this.#routes.push(route);
      this.#snapshot = undefined;
    }, {
      prefix: options.prefix ?? '/',
      namePrefix: '',
      middleware: [],
      group: options.group,
      audit,
    });
    const before = this.#routes.length;
    try {
      for (const definition of definitions) {
        const returned: unknown = definition.register(root);
        if (typeof (returned as { then?: unknown } | undefined)?.then === 'function') {
          throw new Error('defineRoutes() takes a synchronous function: routes registered after its first await would escape the checks made at load.');
        }
      }
    } finally {
      sealed = true;
    }
    const dropped = audit.find((entry) => !entry.used);
    if (dropped) {
      throw new Error(`Route.authorize() at ${dropped.site ?? 'a route file'} made a registrar that never registered a route: its check applies only to routes registered through the registrar it returns — keep it in a constant (const admin = Route.authorize(…)) and register through that. A condition belongs around the whole \`Route.authorize(…)…\` call, not around the routes after it.`);
    }
    if (options.framework === FRAMEWORK_ROUTES) {
      // The exemption is for the framework's own paths alone: a marker in the wrong hands cannot open `/admin`.
      for (const route of this.#routes.slice(before)) {
        if (!isReserved(route.path)) {
          throw new Error(`${route.methods.join('|')} ${showPath(route)}: only routes under /_marmeon/ load as the framework's own — give this one a decision with Route.authorize(…).`);
        }
        route.reserved = true;
        this.#framework.add(route);
      }
    }
    // Compared lowercase and against the marker itself, not truthiness: a path that looks like the framework's must fail closed.
    if (options.framework !== FRAMEWORK_ROUTES) {
      for (const route of this.#routes.slice(before)) {
        if (isReserved(route.path)) {
          throw new Error(`${route.methods.join('|')} ${route.path}: paths under /_marmeon/ belong to the framework — give the routes of an app or a package a prefix of their own. See docs/routing.md#the-frameworks-paths.`);
        }
      }
    }
    this.#indexNames();
    return this;
  }

  /**
   * Runs `hook` before every body schema validates (after `authorize`; a submit and a live validation alike) — it may replace
   * input values with what the schema expects (see {@link ValidationHook}). For packages, while booting.
   */
  beforeValidation(hook: ValidationHook): this {
    this.#validationHooks.push(hook);
    return this;
  }

  /** Answers requests an interceptor claims in the route's place (see {@link RouteInterceptor}). For packages, while booting. */
  intercept(interceptor: RouteInterceptor): this {
    this.#interceptors.push(interceptor);
    return this;
  }

  findByName(name: string): RouteDefinition | undefined {
    return this.#byName.get(name);
  }

  /**
   * Everything a route runs, in order: global middleware, its group's, then its own.
   * Listed twice (a group's and the route's), a middleware runs once, at its first place.
   */
  middlewareFor(route: RouteDefinition): readonly AnyMiddleware[] {
    // Worked out once per route (every request of it needs the same list) — again only after a group changed.
    const cached = this.#middlewareOf.get(route);
    if (cached?.version === this.middleware.version) return cached.list;
    const all = [...this.middleware.get(GLOBAL), ...(route.group ? this.middleware.get(route.group) : []), ...route.middleware];
    const list = Object.freeze([...new Set(all)]);
    this.#middlewareOf.set(route, { version: this.middleware.version, list });
    return list;
  }

  readonly #middlewareOf = new WeakMap<RouteDefinition, { readonly version: number; readonly list: readonly AnyMiddleware[] }>();

  /**
   * The URL of a named route: path parameters filled in, the rest — and `query` —
   * in the query string. Names and parameters are checked against the generated `Routes`.
   *
   * ```ts
   * router.url('user-profile.show', { user: 7 }, { tab: 'links' })   // → /users/7?tab=links
   * ```
   */
  url<const N extends RouteNameInput>(name: CheckRouteName<N>, ...[params, query]: RouteArgs<N>): string {
    return urlFor(this, name, params, query as Query | undefined);
  }

  /** Runs a matched route through its middleware pipeline and action. */
  dispatch(route: RouteDefinition, input: DispatchInput, options: DispatchOptions = {}): Promise<Response> {
    const state = options.state ?? createRequestState(input.request);
    // Whoever calls dispatch directly (a custom server) gets no way around the rule the kernel enforces at start.
    // Judged once per route: a route's checks and bindings are frozen when it is registered.
    let problems = this.#judged.get(route);
    if (problems === undefined) this.#judged.set(route, (problems = this.#problemsOf(route)));
    if (problems.length > 0) return Promise.reject(new RouteAccessError(formatAccessProblems(problems, { path: showPath })));
    const ctx: HttpContext = { ...state, request: input.request, params: input.params, route };
    const toResponse = options.toResponse ?? defaultToResponse;
    const resolve = options.resolve ?? this.#resolve;

    return runPipeline(
      ctx,
      this.middlewareFor(route),
      async (afterMiddleware) => {
        // Bindings after the middleware (authentication answers before a 404 could tell what exists),
        // before `authorize` (which may look at the bound record).
        const finalCtx = route.bindings.length ? { ...afterMiddleware, params: await bindParams(route, afterMiddleware, resolve) } : afterMiddleware;
        const { action } = route;
        // The registrar's checks come first and answer before anything else does — interceptor, live validation and handler
        // alike — so there is no second way into a route that skips them.
        for (const check of route.checks) {
          if ((await check(finalCtx, resolve)) !== true) throw unauthorized();
        }
        // An interceptor or a live validation: the controller is never built, `handle` never runs.
        const interceptor = this.#interceptors.find((candidate) => candidate.claims(finalCtx.request));
        if (interceptor) {
          const request = isControllerClass(action) ? action.request : undefined;
          if (request) await authorizeRequest(request, finalCtx, resolve);
          return interceptor.answer(finalCtx, request, resolve);
        }
        const live = liveValidationFields(finalCtx.request);
        if (live) {
          const method = finalCtx.request.method;
          if (!isControllerClass(action) || !action.request || method === 'GET' || method === 'HEAD' || live.length === 0) throw nothingToValidate();
          await validateRequest(action.request, finalCtx, resolve, { only: live, hooks: this.#validationHooks });
          return new Response(null, { status: 204, headers: { [VALIDATED_HEADER]: live.join(','), 'cache-control': 'no-store' } });
        }
        let result: unknown;
        let pageQuery: PageQuery | undefined;
        if (isControllerClass(action)) {
          // REPR: authorize and validate before the controller is even built.
          let handlerCtx: HttpContext = finalCtx;
          if (action.request) {
            const { body, query } = await validateRequest(action.request, finalCtx, resolve, { hooks: this.#validationHooks });
            if (query) {
              const method = finalCtx.request.method;
              // A URL with an invalid or unknown field may go to its canonical form instead (GET only).
              if (query.dropped.length > 0 && action.request.queryOptions?.onInvalid === 'redirect' && (method === 'GET' || method === 'HEAD')) {
                return canonicalRedirect(finalCtx.request, query.canonical);
              }
              pageQuery = { values: query.canonical, defaults: query.defaults };
            }
            handlerCtx = {
              ...finalCtx,
              ...(action.request.schema ? { body } : {}),
              ...(query ? { query: query.value as unknown as URLSearchParams } : {}),
            };
          }
          try {
            result = await (resolve(action) as unknown as { handle: (ctx: HttpContext) => unknown }).handle(handlerCtx);
          } catch (error) {
            // A ValidationError of the handler (`failOnDuplicate()`'s 422) gets the request's `messages` and `attributes` too.
            throw action.request ? withRequestLabels(error, action.request) : error;
          }
        } else {
          result = await action(finalCtx);
        }
        return toResponse(result, pageQuery ? { ...finalCtx, pageQuery } : finalCtx);
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

/** 302 to the same path with only the valid, non-default fields of the query. */
function canonicalRedirect(request: Request, canonical: Readonly<Record<string, unknown>>): Response {
  const search = toSearchParams(canonical as Query).toString();
  const { pathname } = new URL(request.url);
  return new Response(null, { status: 302, headers: { location: search ? `${pathname}?${search}` : pathname } });
}

/** Resolves the route's bound parameters in order — a scoped one within its already resolved parent. */
async function bindParams(route: RouteDefinition, ctx: HttpContext, resolve: ClassResolver): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { ...(ctx.params as Record<string, string>) };
  for (const binding of route.bindings) {
    const value = params[binding.param];
    if (value === undefined) continue; // an optional parameter that is absent stays absent
    const scope = isScoped(binding)
      ? { param: binding.scopedBy, parent: params[binding.scopedBy], column: binding.column ?? `${binding.scopedBy}_id` }
      : undefined;
    const bound = await resolve(binding.binder).resolveRouteBinding(String(value), { ctx, ...(scope ? { scope } : {}), ...(binding.with ? { with: binding.with } : {}) });
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

/** `error` with the request's labels, when it is a `ValidationError` of issues that has none of its own. */
function withRequestLabels(error: unknown, request: RequestDefinition): unknown {
  if (!(error instanceof ValidationError) || error.labels !== undefined || !error.issues) return error;
  if (request.messages === undefined && request.attributes === undefined) return error;
  return ValidationError.fromIssues(error.issues, error.input, { messages: request.messages, attributes: request.attributes });
}

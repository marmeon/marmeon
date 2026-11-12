import { Html, Redactor } from '@marmeon/core';
import { ISLAND_CONTROLLER, withCode } from '@marmeon/core/internal';
import { formatAccessProblems, isEveryone, isScoped, openBindings, RouteAccessError, routeAccess, type AccessProblem } from './access.ts';
import { buildWithNew } from './default-resolver.ts';
import { HttpError } from './errors.ts';
import { addsConflicts, addsOf, runPipeline, type AddsConflict } from './middleware.ts';
import { GLOBAL, MiddlewareGroups } from './middleware-groups.ts';
import { createRequestState, lowerBodyLimit, type RequestState } from './request.ts';
import { isLiveValidation, liveValidationFields, VALIDATED_HEADER } from './live-validation.ts';
import { authorizeRequest, nothingToValidate, unauthorized, validateRequest, ValidationError, type RequestDefinition, type ValidationHook } from './request-definition.ts';
import { isFallbackDefinition, Route, type RegistrarAudit } from './route.ts';
import { RouteDefinition } from './route-definition.ts';
import type { UrlLocales } from './url-locales.ts';
import type { CheckRouteName, RouteArgs, RouteNameInput } from './routes.ts';
import type { AnyAction, AnyMiddleware, ClassResolver, ControllerClass, HttpContext, HttpMethod, MiddlewareHandler } from './types.ts';
import { localLocation } from './local-location.ts';
import { matchParams, restSegmentProblem, tokenizePattern } from './pattern.ts';
import { restParam, restShape } from './rest-path.ts';
import { fillPath, toSearchParams, urlFor, type Query } from './url.ts';

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
 * this way, so who may submit a form may upload its files. A claimed request that is a live validation too answers 400.
 */
export interface RouteInterceptor {
  /** Whether this request is the interceptor's (a header it looks for). */
  claims(request: Request): boolean;
  answer(ctx: HttpContext, request: RequestDefinition | undefined, resolve: ClassResolver): Response | Promise<Response>;
}

interface RouterOptions {
  /** Default class resolution when `dispatch` gets none. Defaults to building with `new`. */
  resolve?: ClassResolver;
}

export interface DispatchInput {
  request: Request;
  params: Record<string, string>;
}

/**
 * @internal A part of `ResponseContext`. The parsed query of a page's request (`defineRequest({ query })`), for the page object: the fields the URL set
 * (without defaults) and the defaults — so the browser never parses a URL itself (`useQueryState`).
 */
export interface PageQuery {
  readonly values: Readonly<Record<string, unknown>>;
  readonly defaults: Readonly<Record<string, unknown>>;
}

/** @internal The router's: what a response factory gets besides the result: the request — and, behind a query schema, its parsed query. */
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
  /** The locales a localized route's URL can name; the route without its locale redirects with them (`Route.localized()`). @internal */
  urlLocales?: UrlLocales | undefined;
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

/** The health check's paths with no configuration: what the CLI, which never starts the kernel, assumes. */
const DEFAULT_HEALTH_PATHS: readonly string[] = ['/up', '/up/ready'];

/**
 * Whether a localized route's match names a locale the app does not have. A match with no `locale` (a pattern that does not name
 * it) names none, and locales not yet bound (the CLI) leave every value possible: both claim the path.
 *
 * @internal
 */
export const namesOtherLocale = (params: Readonly<Record<string, string>>, supported: readonly string[] | undefined): boolean =>
  supported !== undefined && params.locale !== undefined && !supported.includes(params.locale);

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

/** Turns an action's result into a response: a `Response` as it is, nothing as 204, a string as text, an `Html` as HTML, everything else as JSON. */
export const defaultToResponse: ResponseFactory = (result) => {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return new Response(null, { status: 204 });
  // A string is text, never markup: a route that echoes input must not become reflected XSS. Markup is an `Html`.
  if (typeof result === 'string') return new Response(result, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (result instanceof Html) return new Response(Html.prototype.toString.call(result), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  return Response.json(result);
};

/** Masks secrets in the paths the router names in its errors: a webhook's token must not reach a log. */
const shown = new Redactor();
const showPath = (route: RouteDefinition): string => shown.path(route.path, route.path);

/** What {@link Router.checkRoutes} runs on a route: it throws to refuse it. */
export type RouteCheck = (route: RouteDefinition, resolve: ClassResolver) => void;

/** A route whose middleware declares a key twice (see {@link Router.middlewareProblems}). */
export interface MiddlewareProblem extends AddsConflict {
  readonly route: RouteDefinition;
}

/** Two routes that answer the same method and path: `second` never does, because `first` is registered before it (see {@link Router.routeConflicts}). */
export interface RouteConflict {
  readonly first: RouteDefinition;
  readonly second: RouteDefinition;
  /** The methods both answer; `HEAD` counts as `GET`, which answers it. */
  readonly methods: readonly HttpMethod[];
  /** `rest`: `first` ends in a rest parameter (`/:path*`) that takes the path of `second`; otherwise both have the same path. */
  readonly kind: 'same-path' | 'rest';
}

/**
 * A route pattern with its parameter names taken out: `/notes/:id` and `/notes/:note` have the same shape, `/notes/:id{[0-9]+}`
 * does not. Two routes of one shape and one method are the same address.
 *
 * @internal
 */
export function routeShape(path: string): string {
  return tokenizePattern(path)
    .map((token) => ('text' in token ? token.text : `/:${token.constraint === undefined ? '' : `{${token.constraint}}`}${token.optional ? '?' : ''}${token.rest ? '*' : ''}`))
    .join('');
}

/**
 * One line per conflict, naming both routes with where each was registered; `path` lets a caller redact the path. The same
 * line shape serves any case where one route keeps another from answering.
 *
 * @internal
 */
export function describeRouteConflict({ first, second, methods, kind }: RouteConflict, path: (route: RouteDefinition) => string = showPath): string {
  const where = (route: RouteDefinition) => (route.site ? ` (${route.site})` : '');
  const own = second.methods.join('|');
  const shown = second.generatedFrom
    ? `${own} ${path(second)}${where(second)}, the address without a locale of ${path(second.generatedFrom)},`
    : `${own} ${path(second)}${where(second)}`;
  const reached = new Set<string>(second.methods.map((method) => (method === 'HEAD' ? 'GET' : method)));
  const dead = methods.length === reached.size && methods.every((method) => reached.has(method));
  const which = dead ? 'never answers' : `never answers for ${methods.join('|')}`;
  const why = kind === 'rest' ? 'takes the rest of that path' : 'has the same path';
  return `${shown} ${which}: ${first.methods.join('|')} ${path(first)}${where(first)} ${why} and is registered first — change the path of one of them${dead ? '' : ' (or the methods of one of them)'}. See docs/routing.md#route-order.`;
}

/** One line per conflict: the route, the key and both layers; `path` lets a caller redact the path. @internal */
export function describeMiddlewareProblem({ route, key, first, second }: MiddlewareProblem, path: (route: RouteDefinition) => string = showPath): string {
  const named = (layer: MiddlewareProblem['first']) => `"${layer.name}"`;
  return (
    `${route.methods.join('|')} ${path(route)}: ${named(first)} and ${named(second)} both add "${key}" to the context. ` +
    'Remove one of them: two calls of authenticate() are two middleware, and a route runs both. See docs/middleware.md#listed-twice.'
  );
}

/**
 * Who answers a path: `route` (an app's, a package's or a locale-free address of a localized one), `framework` (a path the
 * server keeps for itself), or `invalid` (a path no fallback would ever get, which is refused as taken). See
 * docs/routing.md#asking-whether-a-path-is-taken.
 */
export type PathClaim =
  | { readonly by: 'route'; readonly route: RouteDefinition }
  | { readonly by: 'framework'; readonly reason: 'reserved' | 'assets' | 'sitemap' | 'health' }
  | { readonly by: 'invalid' };

export class Router {
  readonly #routes: RouteDefinition[] = [];
  /** The route without its locale, for each localized GET route: it redirects to the visitor's language. */
  readonly #unprefixed = new Map<RouteDefinition, RouteDefinition>();
  /** The fallback of each slot, by {@link fallbackSlot}: one per prefix. */
  readonly #fallbackSlots = new Map<string, RouteDefinition>();
  #snapshot: readonly RouteDefinition[] | undefined;
  /** The locales a localized route's first segment can name, once the kernel binds them; none before. */
  #urlLocales: readonly string[] | undefined;
  /** The paths the server's health check answers; before the kernel binds them, the default ones. */
  #healthPaths: readonly string[] = DEFAULT_HEALTH_PATHS;
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
  readonly #routeChecks: RouteCheck[] = [];

  /** @internal Built by the container. */
  constructor(options: RouterOptions = {}) {
    this.#resolve = options.resolve ?? buildWithNew;
  }

  /** A frozen snapshot: pushing a route into it cannot get one past the checks made at load. */
  get routes(): readonly RouteDefinition[] {
    return (this.#snapshot ??= Object.freeze([...this.#routes]));
  }

  /**
   * The routes in the order the server registers them: the framework's paths under `/_marmeon/` first, so no parameter or
   * wildcard route of an app matches ahead of them. The order inside each group is the order of loading. The fallbacks are
   * not in it — {@link Router.fallbacks} has them, and the server registers them after everything else.
   *
   * @internal
   */
  get registrationOrder(): readonly RouteDefinition[] {
    const routes = this.#routes.filter((route) => !isFallbackDefinition(route));
    // The routes without a locale come last: a route of the app always wins, and they answer only what would be a 404 otherwise.
    return [...routes.filter((route) => route.reserved), ...routes.filter((route) => !route.reserved), ...this.#unprefixed.values()];
  }

  /**
   * The routes `Route.fallback()` made, the one under the longest prefix first: the server registers them after every other
   * route, so they answer what nothing else takes.
   *
   * @internal
   */
  get fallbacks(): readonly RouteDefinition[] {
    return this.#routes.filter(isFallbackDefinition).sort(fallbackOrder);
  }

  /** Whether `Route.fallback()` made the route; a definition built by hand never is. @internal */
  isFallback(route: RouteDefinition): boolean {
    return isFallbackDefinition(route);
  }

  /**
   * Whether a route, a package or the framework already answers `path` — the decoded path with its leading `/`, as a
   * fallback's `'/' + ctx.params.path` — so a slug can be refused before it is saved. A path no fallback would get (empty,
   * dot or `\` segments, a trailing `/`) is `{ by: 'invalid' }`, never free. See docs/routing.md#asking-whether-a-path-is-taken.
   */
  claimedBy(path: string): PathClaim | undefined {
    // A value that is no string (a JavaScript caller's `undefined`) is no path anyone could take: refused, not free.
    if (typeof path !== 'string' || !path.startsWith('/')) return { by: 'invalid' };
    // The one rule the rest parameter reads a request with: a path that fails it is none a fallback is given.
    const segments = path === '/' ? [] : path.slice(1).split('/');
    if (segments.some((segment) => restSegmentProblem(segment) !== undefined)) return { by: 'invalid' };
    let seen: string;
    try {
      // As the server reads a request: each segment encoded, then `decodeURI` with `%25` kept (the server writes it `%2525` first,
      // so a literal `%` stays one) and `%2F`, `%3F` and the other reserved characters left as they are.
      seen = decodeURI(`/${segments.map(encodeURIComponent).join('/')}`.replace(/%25/g, '%2525'));
    } catch {
      return { by: 'invalid' };
    }
    if (isReserved(path)) return { by: 'framework', reason: 'reserved' };
    if (path === '/assets' || path.startsWith('/assets/')) return { by: 'framework', reason: 'assets' };
    if ((path === '/sitemap.xml' || path === '/robots.txt') && this.#routes.some((route) => route.inSitemap)) return { by: 'framework', reason: 'sitemap' };
    // The server answers these before any route; a path of its own (a moved health check) counts like the default.
    if (this.#healthPaths.includes(path)) return { by: 'framework', reason: 'health' };
    for (const route of this.registrationOrder) {
      if (!route.methods.includes('GET')) continue;
      const params = matchParams(route.path, seen);
      if (!params) continue;
      // Not bound (the CLI): any first segment may be a locale, so the route claims it.
      if (route.localized && namesOtherLocale(params, this.#urlLocales)) continue;
      return { by: 'route', route: route.generatedFrom ?? route };
    }
    return undefined;
  }

  /**
   * @internal The kernel tells the router what the server owns besides routes, for {@link Router.claimedBy}: the locales a
   * localized route's URL can name, and the paths of the health check (none when it is off). Unbound, any first segment may be a
   * locale and the default health paths count.
   */
  bindServerPaths({ locales, health }: { readonly locales?: readonly string[] | undefined; readonly health: readonly string[] }): void {
    this.#urlLocales = locales;
    this.#healthPaths = health;
  }

  /**
   * Whether a request path lies under `/_marmeon/` — in any case, with a doubled leading slash counted as one. The server
   * answers such a path no framework route took with a 404 before any route of an app is tried.
   *
   * @internal
   */
  isReservedPath(path: string): boolean {
    return isReserved(path.replace(/^\/+/, '/'));
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
    // The route without its locale decides nothing: it only redirects to the localized route, which answers for itself.
    if (this.#framework.has(route) || route.generatedFrom) return [];
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
      if (dropped.method === 'afterAuthorize') {
        throw new Error(`Route.afterAuthorize() at ${dropped.site ?? 'a route file'} made a registrar that never registered a route: its hook applies only to routes registered through the registrar it returns — keep it in a constant (const shared = Route.afterAuthorize(…)) and register through that.`);
      }
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
    // A binder that ignores `binding.scope` would find a record of another parent; untyped code gets past the type that refuses it.
    for (const route of this.#routes.slice(before)) {
      const unscoped = unscopedBinder(route);
      if (unscoped) throw unscoped;
    }
    // Nothing a request does (`ctx.route`) may change a route for the requests after it.
    for (const route of this.#routes.slice(before)) route.seal();
    for (const route of this.#routes.slice(before)) {
      if (!route.localized || !route.methods.includes('GET')) continue;
      const variant = new RouteDefinition({
        methods: ['GET'],
        path: route.path.replace(/^\/:locale/, '') || '/',
        action: unprefixedAction,
        middleware: [],
        namePrefix: '',
        group: route.group,
        site: route.site,
        generatedFrom: route,
      });
      variant.seal();
      this.#unprefixed.set(route, variant);
    }
    this.#checkFallbacks(this.#routes.slice(before));
    for (const route of this.#routes.slice(before)) if (route.inSitemap) checkSitemapRoute(route);
    this.#indexNames();
    for (const route of this.#routes.slice(before)) for (const check of this.#routeChecks) check(route, this.#resolve);
    return this;
  }

  /**
   * Runs `check` on every route loaded so far and on each one loaded later, as it loads — what it throws stops the start. For
   * packages, while booting.
   *
   * @internal
   */
  checkRoutes(check: RouteCheck): this {
    this.#routeChecks.push(check);
    for (const route of this.#routes) check(route, this.#resolve);
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

  /** @internal Used by the redirect, signed-URL and test helpers. */
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

  /**
   * The routes whose middleware has two layers that declare the same key in `adds` (`authenticate()` in a group and again on a
   * route): which route, which key, and both layers. The kernel and `marmeon check` refuse them at start.
   *
   * @internal
   */
  middlewareProblems(): MiddlewareProblem[] {
    return this.#routes.flatMap((route) => addsConflicts(this.middlewareFor(route)).map((conflict) => ({ route, ...conflict })));
  }

  /**
   * The routes that can never answer: an earlier one has the same method and the same path (parameter names aside). Loaded
   * routes come in the order of registration, the routes without a locale last; the framework's own paths are left out.
   * Nothing is refused here: `marmeon check` and the kernel warn.
   *
   * @internal
   */
  routeConflicts(): RouteConflict[] {
    const conflicts: RouteConflict[] = [];
    /** The routes seen so far in registration order; `prefix` is the shape before the rest parameter of a route that ends in one. */
    const before: { readonly route: RouteDefinition; readonly shape: string; readonly prefix: string | undefined }[] = [];
    // Hono answers HEAD through the GET routes: a route of HEAD alone never matches, so it keeps nothing from a later route.
    const answered = (first: RouteDefinition): readonly HttpMethod[] => first.methods.filter((method) => method !== 'HEAD');
    for (const route of this.registrationOrder) {
      if (this.#framework.has(route)) continue;
      // A localized route answers only the app's locales, so its first segment is no free parameter: it clashes with another localized route alone.
      const shape = route.localized ? `/:{locale}${routeShape(route.path.replace(/^\/:locale/, ''))}` : routeShape(route.path);
      const open = new Set<HttpMethod>(route.methods.map((method) => (method === 'HEAD' ? 'GET' : method)));
      // In registration order, so each report names the earliest route that takes the methods; an earlier rest route answers its own prefix and every path below it.
      for (const { route: first, shape: firstShape, prefix } of before) {
        if (open.size === 0) break;
        const kind = firstShape === shape ? 'same-path' : prefix !== undefined && (shape === prefix || shape.startsWith(`${prefix}/`)) ? 'rest' : undefined;
        // The routes without a locale of two localized routes clash because the routes themselves do, which is reported once.
        if (kind === undefined || (route.generatedFrom && first.generatedFrom)) continue;
        const shared = [...open].filter((method) => answered(first).includes(method));
        if (shared.length === 0) continue;
        conflicts.push({ first, second: route, methods: shared, kind });
        for (const method of shared) open.delete(method);
      }
      before.push({ route, shape, prefix: shape.endsWith('/:*') ? shape.slice(0, -3) : undefined });
    }
    return conflicts;
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

  /**
   * Runs a matched route through its middleware pipeline and action.
   * @internal
   */
  dispatch(route: RouteDefinition, given: DispatchInput, options: DispatchOptions = {}): Promise<Response> {
    let input = given;
    const rest = restShape(route.path);
    if (rest) {
      // Security invariant: the value is worked out from the raw path, never from the server's match (`%2F` and `//host` would
      // reach the controller as paths of this site), and it replaces whatever a caller passed under that name.
      const url = new URL(given.request.url);
      const found = restParam(route.path, url.pathname, given.request.method, url.search, given.params);
      if (found.kind === 'refused') return this.dispatchGlobal(given.request, () => Promise.reject(new HttpError(404)), options);
      if (found.kind === 'redirect') {
        return this.dispatchGlobal(given.request, () => new Response(null, { status: 301, headers: { location: found.location } }), options);
      }
      input = { request: given.request, params: { ...given.params, [rest.name]: found.value } };
    }
    const state = options.state ?? createRequestState(input.request);
    // Whoever calls dispatch directly (a custom server) gets no way around the rules the kernel enforces at start.
    const unscoped = unscopedBinder(route);
    if (unscoped) return Promise.reject(unscoped);
    // Judged once per route: a route's checks and bindings are frozen when it is registered.
    let problems = this.#judged.get(route);
    if (problems === undefined) this.#judged.set(route, (problems = this.#problemsOf(route)));
    if (problems.length > 0) return Promise.reject(new RouteAccessError(formatAccessProblems(problems, { path: showPath })));
    // Frozen, flat: a layer extends the context with next({…}) and cannot assign to it (deep values stay as they are).
    const ctx: HttpContext = Object.freeze({ ...state, request: input.request, params: Object.freeze({ ...input.params }), route });
    // Before any middleware: the CSRF check reads a form's body, so the limit has to hold already.
    const tooLarge = route.bodyLimit === undefined ? undefined : lowerBodyLimit(input.request, route.bodyLimit);
    const toResponse = options.toResponse ?? defaultToResponse;
    const resolve = options.resolve ?? this.#resolve;

    const run = () => runPipeline(
      ctx,
      this.middlewareFor(route),
      async (afterMiddleware) => {
        // No bindings, checks or interceptor for the route without its locale: it answers with the redirect and nothing else.
        if (route.generatedFrom) return redirectToLocale(route.generatedFrom, afterMiddleware, options.urlLocales);
        // Bindings after the middleware (authentication answers before a 404 could tell what exists),
        // before `authorize` (which may look at the bound record).
        const finalCtx: HttpContext = route.bindings.length
          ? Object.freeze({ ...afterMiddleware, params: Object.freeze(await bindParams(route, afterMiddleware, resolve)) })
          : afterMiddleware;
        const { action } = route;
        // The registrar's checks come first and answer before anything else does — interceptor, live validation and handler
        // alike — so there is no second way into a route that skips them.
        for (const check of route.checks) {
          if ((await check(finalCtx, resolve)) !== true) throw unauthorized();
        }
        // The request's own `authorize` is the last decision. Only then do the hooks run: what they share about a bound record
        // never reaches an answer to somebody who may not see it, whichever of the paths below answers.
        const request = isControllerClass(action) ? action.request : undefined;
        if (request) await authorizeRequest(request, finalCtx, resolve);
        for (const hook of route.afterAuthorize) await hook(finalCtx, resolve);
        // An interceptor or a live validation: the controller is never built, `handle` never runs.
        const interceptor = this.#interceptors.find((candidate) => candidate.claims(finalCtx.request));
        if (interceptor) {
          // The middleware took this request for a live validation — `throttle()` holds one to the route's limit without
          // counting it — so no interceptor may answer it: an upload target would get past the route's limit.
          if (isLiveValidation(finalCtx.request)) throw new HttpError(400, 'A live validation (x-marmeon-validate) is answered by its route’s validation, never by an interceptor such as an upload target.');
          return interceptor.answer(finalCtx, request, resolve);
        }
        const live = liveValidationFields(finalCtx.request);
        if (live) {
          const method = finalCtx.request.method;
          if (!isControllerClass(action) || !action.request || method === 'GET' || method === 'HEAD' || live.length === 0) throw nothingToValidate();
          await validateRequest(action.request, finalCtx, resolve, { only: live, hooks: this.#validationHooks, authorized: true });
          return new Response(null, { status: 204, headers: { [VALIDATED_HEADER]: live.join(','), 'cache-control': 'no-store' } });
        }
        let result: unknown;
        let pageQuery: PageQuery | undefined;
        if (isControllerClass(action)) {
          // REPR: authorize and validate before the controller is even built.
          let handlerCtx: HttpContext = finalCtx;
          if (action.request) {
            const { body, query } = await validateRequest(action.request, finalCtx, resolve, { hooks: this.#validationHooks, authorized: true });
            if (query) {
              const method = finalCtx.request.method;
              // A URL with an invalid or unknown field may go to its canonical form instead (GET only).
              if (query.dropped.length > 0 && action.request.queryOptions?.onInvalid === 'redirect' && (method === 'GET' || method === 'HEAD')) {
                return canonicalRedirect(finalCtx.request, query.canonical);
              }
              pageQuery = { values: query.canonical, defaults: query.defaults };
            }
            handlerCtx = Object.freeze({
              ...finalCtx,
              ...(action.request.schema ? { body } : {}),
              ...(query ? { query: query.value as unknown as URLSearchParams } : {}),
            });
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
        return toResponse(result, pageQuery ? Object.freeze({ ...finalCtx, pageQuery }) : finalCtx);
      },
      { resolve, onTerminable: options.onTerminable, onError: options.onError },
    );
    // A declared length over the limit, or a body read before the match that is over it, ends the request with the 413 before any middleware.
    return tooLarge ? tooLarge.then(run, (error: unknown) => (options.onError ? options.onError(error, ctx) : Promise.reject(error))) : run();
  }

  /**
   * A request no route matched: it still passes the global middleware (security
   * headers, request logging, …), then ends in a 404.
   * @internal
   */
  dispatchNotFound(request: Request, options: Omit<DispatchOptions, 'toResponse'> = {}): Promise<Response> {
    return this.dispatchGlobal(request, () => Promise.reject(new HttpError(404)), options);
  }

  /**
   * Runs `answer` behind the global middleware only (no group: no session, no CSRF), as the kernel's own endpoints
   * (`/sitemap.xml`) do.
   *
   * @internal
   */
  dispatchGlobal(request: Request, answer: (ctx: HttpContext) => Response | Promise<Response>, options: Omit<DispatchOptions, 'toResponse'> = {}): Promise<Response> {
    const state = options.state ?? createRequestState(request);
    const ctx = Object.freeze({ ...state, request, params: Object.freeze({}) }) as unknown as HttpContext;
    return runPipeline(ctx, this.middleware.get(GLOBAL), async (afterMiddleware) => answer(afterMiddleware), {
      resolve: options.resolve ?? this.#resolve,
      onTerminable: options.onTerminable,
      onError: options.onError,
    });
  }

  /**
   * Refuses what would leave a fallback without its place: a second one for a prefix, one outside the `web` group, and a route
   * that has its form or covers it — in either order of loading, since `added` is checked against everything loaded so far.
   */
  #checkFallbacks(added: readonly RouteDefinition[]): void {
    for (const route of added) {
      if (!isFallbackDefinition(route)) continue;
      // Fail closed: a route loaded without a group (a package's `boot()` may do that) runs without the web group's middleware.
      if (route.group !== 'web') {
        throw new Error(withCode('H15', `Route.fallback() at ${route.site ?? 'a route file'} is ${route.group === undefined ? 'in no group' : `in the ${route.group} group`}: a fallback answers pages, so it belongs in the web group — load it with { group: 'web' }. See docs/routing.md#the-fallback-route.`));
      }
      // The server answers `/assets` and everything below it with a 404 before any fallback; compared in the case Hono matches.
      const under = fallbackPrefix(route);
      if (under === '/assets' || under.startsWith('/assets/')) {
        throw new Error(withCode('H15', `Route.fallback() at ${route.site ?? 'a route file'} sits under ${under}, which belongs to the build's files: the server answers every path there with a 404 before a fallback, so this one would never answer. Give it another prefix. See docs/routing.md#the-fallback-route.`));
      }
      const slot = fallbackSlot(route);
      const held = this.#fallbackSlots.get(slot);
      if (held) {
        throw new Error(withCode('H15', `Two fallbacks answer ${showFallbackPrefix(route)}: ${atSite(held)} and ${atSite(route)}. A fallback takes every path no route takes under its prefix, so only one fits — move one under another prefix with Route.prefix(…). See docs/routing.md#the-fallback-route.`));
      }
      this.#fallbackSlots.set(slot, route);
    }
    // The address without a locale of a localized route redirects every path it matches, so it takes part like a route of its own.
    const every = [...this.#routes, ...this.#unprefixed.values()];
    const addedEvery = [...added, ...added.flatMap((route) => this.#unprefixed.get(route) ?? [])];
    for (const route of addedEvery) {
      for (const other of every) {
        if (route === other) continue;
        const fallback = isFallbackDefinition(route) ? route : other;
        const plain = fallback === route ? other : route;
        if (!isFallbackDefinition(fallback) || isFallbackDefinition(plain) || this.#framework.has(plain) || plain.localized || !plain.methods.includes('GET')) continue;
        const named = plain.generatedFrom ? `${atSite(plain)}, the address without a locale of ${atSite(plain.generatedFrom)},` : atSite(plain);
        if (routeShape(plain.path) === routeShape(fallback.path)) {
          throw new Error(withCode('H15', `GET ${named} has the form of the fallback ${atSite(fallback)}: it takes every path under ${showFallbackPrefix(fallback)} before the fallback is asked, so the fallback would never answer there. Use Route.fallback() for it, or give the route a path of its own. See docs/routing.md#the-fallback-route.`));
        }
        if (coversPrefix(plain, fallbackPrefix(fallback))) {
          throw new Error(withCode('H15', `GET ${named} takes the rest of the path and covers the fallback ${atSite(fallback)}: it answers everything under ${showFallbackPrefix(fallback)} first, so the fallback would never answer. Make it a Route.fallback() or give it a longer prefix. See docs/routing.md#the-fallback-route.`));
        }
      }
    }
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

/** What a fallback's path ends with: the rest of the path, which `Route.fallback()` always names `path`. */
const FALLBACK_TAIL = '/:path*';

/** The path a fallback sits under: `''` at the root, `/help` for `/help/:path*`. */
const fallbackPrefix = (route: RouteDefinition): string => route.path.slice(0, -FALLBACK_TAIL.length);

/**
 * The key of the slot a fallback takes: one per prefix, written with its kind so another kind of slot can be added next to it.
 * Two fallbacks with the same key cannot both answer.
 */
const fallbackSlot = (route: RouteDefinition): string => `path:${fallbackPrefix(route)}`;

const prefixSegments = (prefix: string): string[] => prefix.split('/').filter(Boolean);

/** The longer prefix first, so `/help/:path*` is tried before `/:path*`; equal lengths are other prefixes, which never overlap. */
function fallbackOrder(a: RouteDefinition, b: RouteDefinition): number {
  return prefixSegments(fallbackPrefix(b)).length - prefixSegments(fallbackPrefix(a)).length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

const showFallbackPrefix = (route: RouteDefinition): string => (fallbackPrefix(route) === '' ? 'the root' : shown.path(fallbackPrefix(route), fallbackPrefix(route)));
const atSite = (route: RouteDefinition): string => `${showPath(route)}${route.site ? ` (${route.site})` : ''}`;

/** The constraint as the server anchors it, or `undefined` when it is no regular expression (refused elsewhere). */
function anchored(constraint: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${constraint})$`);
  } catch {
    return undefined;
  }
}

/**
 * The constraints that take any value, written out: nothing else counts, since a start error must not rest on a guess about
 * what a regular expression matches. A path holds no newline (decoded control characters are refused), so `.` takes anything.
 */
const TAKES_ANYTHING = /^(?:\((?:\?:)(?:\.[*+]|\[\\s\\S\][*+]|\[\^\][*+])\)|\.[*+]|\[\\s\\S\][*+]|\[\^\][*+])$/;

/**
 * Whether `route` answers every path under the fallback's `prefix`: it is segments (literals and parameters) followed by a
 * rest parameter or one whose constraint is a {@link TAKES_ANYTHING} form, and each of its segments accepts the prefix's
 * segment at its place — a literal the same, a parameter without constraint any, one with a constraint if it matches. What
 * remains of the prefix under the last parameter is taken with everything below. Any other constraint leaves the fallback paths
 * (`/help/:p{a/.*}`, `/:slug{[a-z]+/[a-z]+}`, `/:p{[^!]+}`), and a pattern that does take anything in another spelling is missed.
 */
function coversPrefix(route: RouteDefinition, prefix: string): boolean {
  const tokens = tokenizePattern(route.path);
  const last = tokens.at(-1);
  if (!last || !('name' in last) || !(last.rest || (last.constraint !== undefined && TAKES_ANYTHING.test(last.constraint.trim())))) return false;
  const slots: ({ readonly literal: string } | { readonly constraint: string | undefined })[] = [];
  // Only the last parameter of a pattern may be optional (H13), so none of these is.
  for (const token of tokens.slice(0, -1)) {
    if ('text' in token) slots.push(...prefixSegments(token.text).map((literal) => ({ literal })));
    else slots.push({ constraint: token.constraint });
  }
  const fallback = prefixSegments(prefix);
  if (slots.length > fallback.length) return false;
  const fits = slots.every((slot, index) => {
    if ('literal' in slot) return slot.literal === fallback[index];
    return slot.constraint === undefined || (anchored(slot.constraint)?.test(fallback[index]!) ?? false);
  });
  if (!fits) return false;
  return true;
}

/**
 * Refuses a route marked with `.sitemap()` that cannot be a page anyone opens: a write, a route the browser never learns, an API
 * route, one behind `user`, or one with parameters whose controller does not say which are pages.
 */
function checkSitemapRoute(route: RouteDefinition): void {
  const at = `${route.methods.join('|')} ${showPath(route)}`;
  const refuse = (reason: string): never => {
    throw new TypeError(withCode('H10', `sitemap() on ${at}: ${reason}. See docs/seo.md#sitemap-and-robotstxt.`));
  };
  if (route.methods.length !== 1 || route.methods[0] !== 'GET') refuse('a sitemap lists GET pages only');
  if (route.isInternal) refuse('an internal() route is not a public page');
  if (route.group === 'api') refuse('an API route is not a page');
  if (route.middleware.some((middleware) => addsOf(middleware).includes('user'))) refuse('a sitemap lists pages anyone can open, and this route sits behind a signed-in user');
  // Everyone, and said so: a check that asks who the visitor is (a policy, a role, a login middleware without `adds`) is no public page.
  const checks = routeAccess(route);
  if (checks.length === 0 || !checks.every(isEveryone)) refuse('a sitemap lists pages anyone can open, and this route asks who may call it (authorize(everyone) says that anyone may)');
  // The `/:locale` of a localized route is not one of its parameters: the sitemap fills it for every language.
  if (tokenizePattern(route.localized ? route.path.replace(/^\/:locale/, '') : route.path).some((token) => 'name' in token) && !(isControllerClass(route.action) && typeof route.action.prototype.sitemap === 'function')) {
    refuse('the path has parameters, so its controller needs a sitemap() method that returns the entries (a closure cannot)');
  }
}

/** The action slot of a route without its locale: `dispatch` answers it with the redirect, so this never runs. */
const unprefixedAction: AnyAction = () => {
  throw new Error('A route without its locale is answered by Router.dispatch().');
};

/**
 * 302 from a localized route's URL without its locale to the same page under the visitor's: the target is the route's own
 * pattern filled with the matched parameters (every value encoded) and the preferred locale, plus the query as it came —
 * never the path the request used, so no `//host` or `/\\host` can become the `Location`. The answer depends on the cookie and
 * the language header, so no shared cache keeps it.
 */
async function redirectToLocale(target: RouteDefinition, ctx: HttpContext, urlLocales: UrlLocales | undefined): Promise<Response> {
  if (!urlLocales) throw new Error(`${target.path} is a localized route: the locales it can name are missing — @marmeon/i18n binds them.`);
  // Hono decodes the path: `%2E%2E` arrives as `..`, which `fillPath` refuses — such a URL is no page.
  if (Object.values(ctx.params).some((value) => value === '.' || value === '..')) throw new HttpError(404);
  const locale = await urlLocales.preferred(ctx);
  if (!urlLocales.supported.includes(locale)) throw new Error(`The preferred locale [${locale}] is none of the supported ones (${urlLocales.supported.join(', ')}).`);
  const { path } = fillPath(target.routeName ?? target.path, target.path, { ...(ctx.params as Record<string, string>), locale });
  return new Response(null, {
    status: 302,
    headers: { location: path + new URL(ctx.request.url).search, 'cache-control': 'private, no-store', vary: 'accept-language, cookie' },
  });
}

/** 302 to the same path with only the valid, non-default fields of the query. */
function canonicalRedirect(request: Request, canonical: Readonly<Record<string, unknown>>): Response {
  const search = toSearchParams(canonical as Query).toString();
  const { pathname } = new URL(request.url);
  return new Response(null, { status: 302, headers: { location: localLocation(pathname, search ? `?${search}` : '') } });
}

/** H11 for the first scoped binding of `route` whose binder does not say it reads `binding.scope`; none when all do. */
function unscopedBinder(route: RouteDefinition): Error | undefined {
  for (const binding of route.bindings) {
    if (isScoped(binding) && binding.binder.routeBindingScoped !== true) {
      return new Error(
        withCode(
          'H11',
          `${route.methods.join('|')} ${showPath(route)}: ${binding.binder.name || 'the binder'} of \`${binding.param}\` is scoped by \`${binding.scopedBy}\` but does not say it reads binding.scope — declare static readonly routeBindingScoped = true on it and look the record up within its parent. See docs/routing.md#your-own-binder.`,
        ),
      );
    }
  }
  return undefined;
}

/** Resolves the route's bound parameters in order — a scoped one within its already resolved parent. */
async function bindParams(route: RouteDefinition, ctx: HttpContext, resolve: ClassResolver): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { ...(ctx.params as Record<string, string>) };
  for (const binding of route.bindings) {
    const value = params[binding.param];
    if (value === undefined) continue; // an optional parameter that is absent stays absent
    // Without the parent there is nothing to look within: the binder is not asked.
    if (isScoped(binding) && params[binding.scopedBy] === undefined) throw new HttpError(404);
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

/**
 * Whether a route's action is a controller the loader marked as answering with an island (it calls `this.island()` or
 * `island()` from `@marmeon/http`, see docs/deferred-props.md#the-islands-route). Closures are never islands. A subclass
 * inherits the mark.
 */
export function isIslandAction(action: AnyAction): boolean {
  return isControllerClass(action) && (action as unknown as Record<symbol, unknown>)[Symbol.for(ISLAND_CONTROLLER)] === true;
}

/** `error` with the request's labels, when it is a `ValidationError` of issues that has none of its own. */
function withRequestLabels(error: unknown, request: RequestDefinition): unknown {
  if (!(error instanceof ValidationError) || error.labels !== undefined || !error.issues) return error;
  if (request.messages === undefined && request.attributes === undefined) return error;
  return ValidationError.fromIssues(error.issues, error.input, { messages: request.messages, attributes: request.attributes });
}

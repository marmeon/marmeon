import { withCode } from '@marmeon/core/internal';
import { isScoped, registrationSite, siteOf, type AccessCheck } from './access.ts';
import { assertMiddleware } from './middleware.ts';
import type { NoReservedKeys, ReservedContextKey } from './middleware.ts';
import { RouteDefinition } from './route-definition.ts';
import type { StandardSchemaV1 } from './request-definition.ts';
import type {
  Action,
  AnyAction,
  AnyMiddleware,
  BindingWith,
  BoundValue,
  ClassResolver,
  ConsistentBinder,
  EmptyObject,
  ExtractParams,
  HttpContext,
  HttpMethod,
  Merge,
  MiddlewareLike,
  RegionResultMarker,
  RouteBinderClass,
  RouteBinding,
  Simplify,
} from './types.ts';
import { patternProblem, tokenizePattern } from './pattern.ts';

/** What `with` takes for a binder that loads nothing besides the record — the message the compiler shows. */
type NoRelations = 'this binder loads nothing with the record — only one with a routeBindingWith does, such as a repository';

/**
 * `bind()`'s options: unscoped, or scoped by a parameter bound before (`scopedBy`, and the `column` that points at it) — a `column`
 * alone would bind without the parent. `with` goes with both.
 */
type BindOptions<TScope extends string, TWith, TScoping extends boolean> =
  | { readonly scopedBy?: never; readonly column?: never; readonly public?: true; readonly with?: TWith }
  | {
      readonly scopedBy: TScoping extends false ? NotScoping : [TScope] extends [never] ? NoParent : TScope;
      readonly column?: string;
      readonly public?: true;
      readonly with?: TWith;
    };

/** What `scopedBy` takes for a binder that does not say it scopes — the message the compiler shows. */
type NotScoping = 'this binder does not say it finds a record within its parent — declare static readonly routeBindingScoped = true and read binding.scope, as a repository does';

/** What `scopedBy` takes before any parameter is bound — the message the compiler shows. */
type NoParent = 'scopedBy names a parameter bound before this one — bind the parent first: Route.bind(parent, …).bind(child, …, { scopedBy: parent })';

/** A registrar made by `authorize()`; `used` turns true when a route is registered through it or one derived from it. */
export interface RegistrarAudit {
  used: boolean;
  readonly site: string | undefined;
}

export interface GroupAttributes {
  readonly prefix: string;
  readonly namePrefix: string;
  readonly middleware: readonly AnyMiddleware[];
  /** Middleware group of every route registered through this registrar (`web`, `api`). */
  readonly group?: string | undefined;
  readonly bindings?: readonly RouteBinding[];
  /** Checks of every route registered through this registrar (`Route.authorize`), in declaration order. */
  readonly checks?: readonly AccessCheck[];
  /** Where `authorize()` registrars are recorded, so `Router.load` can refuse one that registered nothing. */
  readonly audit?: RegistrarAudit[];
  /** The `authorize()` registrars this one descends from. */
  readonly pending?: readonly RegistrarAudit[];
  /** Every route of the group is internal: never sent to the browser (`RouteDefinition.internal()`). */
  readonly internal?: boolean;
  /** Every route of the group lives under `/:locale` (`Route.localized()`). */
  readonly localized?: boolean;
}

/** Path parameters, with bound ones replaced by what their binder resolves (`Route.bind`). */
type RouteContext<TState extends object, TParams extends object, TBindings extends object, TPath extends string> = HttpContext<
  TState,
  Merge<TParams & ExtractParams<TPath>, TBindings>
>;

/**
 * The action — or, when a bound parameter is missing from the path, a type that says so
 * (`Route.bind('user', …).get('/users/:id', …)` is a compile error naming `user`).
 */
type RouteAction<
  TState extends object,
  TParams extends object,
  TBindings extends object,
  TPath extends string,
  TSchema extends StandardSchemaV1,
  TQuery extends StandardSchemaV1,
  TResult = unknown,
> =
  Exclude<keyof TBindings, keyof (TParams & ExtractParams<TPath>)> extends infer Missing extends PropertyKey
    ? [Missing] extends [never]
      ? Action<RouteContext<TState, TParams, TBindings, TPath>, TSchema, TQuery, TResult>
      : `Route.bind('${Missing & string}') needs a :${Missing & string} parameter in the path`
    : never;

/** What a GET route says to a controller whose request validates a body: there is none. */
export const GET_HAS_NO_BODY = 'a GET request has no body — validate its URL with `query` (defineRequest({ query }))';

/** A GET route's action: like any other, but a request with a body `schema` is refused. */
type GetRouteAction<
  TState extends object,
  TParams extends object,
  TBindings extends object,
  TPath extends string,
  TSchema extends StandardSchemaV1,
  TQuery extends StandardSchemaV1,
> = [TSchema] extends [never] ? RouteAction<TState, TParams, TBindings, TPath, TSchema, TQuery> : typeof GET_HAS_NO_BODY;

/** What a route of another method than GET says to a controller that answers with an island. */
export const ISLAND_IS_GET_ONLY = 'this.island(…) answers GET requests only — an island reads, it never changes anything: register it with Route.get';

/** The action of a route that is not a GET: like any other, but an island (`this.island(…)`) is refused. */
type NonGetRouteAction<
  TState extends object,
  TParams extends object,
  TBindings extends object,
  TPath extends string,
  TSchema extends StandardSchemaV1,
  TQuery extends StandardSchemaV1,
  TResult,
> = [Extract<Awaited<TResult>, RegionResultMarker>] extends [never]
  ? RouteAction<TState, TParams, TBindings, TPath, TSchema, TQuery, TResult>
  : typeof ISLAND_IS_GET_ONLY;

export function joinPaths(...segments: string[]): string {
  const parts = segments.flatMap((segment) => segment.split('/')).filter(Boolean);
  return `/${parts.join('/')}`;
}

/**
 * Fluent, immutable route registrar: every attribute call returns a *new* registrar, so the
 * accumulated context type (`TState`) and path parameters (`TParams`) flow into nested groups. See docs/routing.md#route-groups.
 */
export class Route<TState extends object = EmptyObject, TParams extends object = EmptyObject, TBindings extends object = EmptyObject> {
  readonly #register: (route: RouteDefinition) => void;
  readonly #attributes: GroupAttributes;

  constructor(
    register: (route: RouteDefinition) => void,
    attributes: GroupAttributes = { prefix: '/', namePrefix: '', middleware: [] },
  ) {
    this.#register = register;
    this.#attributes = attributes;
  }

  // -- Group attributes ------------------------------------------------------

  prefix<const TPath extends string>(path: TPath): Route<TState, Simplify<TParams & ExtractParams<TPath>>, TBindings> {
    return this.#with({ prefix: joinPaths(this.#attributes.prefix, path) });
  }

  /**
   * Puts every route registered through the returned registrar under `/:locale`, which the server limits to the app's locales:
   * `Route.localized().prefix('/about')` serves `/de/about` and `/en/about`; `/about` redirects to the visitor's language. Only
   * as the first call: the locale is the first segment of the path. See docs/routing.md#routes-under-a-locale.
   */
  localized(): Route<TState, Simplify<TParams & { locale: string }>, TBindings> {
    if (this.#attributes.localized || this.#attributes.prefix !== '/') {
      throw new TypeError(`Route.localized() cannot follow ${this.#attributes.localized ? 'Route.localized()' : `Route.prefix('${this.#attributes.prefix}')`}: call localized() first: the locale is the first segment of the path.`);
    }
    return this.#with({ prefix: '/:locale', localized: true });
  }

  /** Prefix for route names in this group, e.g. `name('admin.')`. */
  name(prefix: string): Route<TState, TParams, TBindings> {
    return this.#with({ namePrefix: this.#attributes.namePrefix + prefix });
  }

  /**
   * Appends middleware. It must accept the context built so far, and whatever it
   * passes to `next()` becomes available to everything registered after it.
   */
  middleware<TAdds extends object & NoReservedKeys = EmptyObject>(middleware: MiddlewareLike<TState, TAdds>): Route<Merge<TState, Omit<TAdds, ReservedContextKey>>, TParams, TBindings> {
    // Untyped code gets past the signature; a second argument dropped silently would leave the route without that middleware.
    if (arguments.length > 1) {
      throw new TypeError(`Route.middleware() takes one middleware — got ${arguments.length} at ${this.#attributes.prefix}; chain them: Route.middleware(a).middleware(b).`);
    }
    assertMiddleware(middleware, `Route.middleware() at ${this.#attributes.prefix}`);
    return this.#with({ middleware: [...this.#attributes.middleware, middleware] });
  }

  /**
   * Resolves the route parameter `param` with `binder`: the action gets the record instead of
   * the string, a missing one answers 404. Registered before the route, like middleware, so the type reaches `handle`. A scoped
   * binding (`scopedBy`) looks the child up *within* its parent (`team_id = team.id`, or `column`), so an id from somewhere else
   * is a 404 — insecure direct object references cannot happen by forgetting a check. Only a binder that declares
   * `routeBindingScoped` takes `scopedBy`; without it the app does not start. See docs/routing.md#scoped-bindings. `with`
   * names relations a repository loads with the record, in the same query: docs/routing.md#loading-relations-with-the-record.
   */
  bind<const TName extends string, B extends RouteBinderClass<unknown>, const TScope extends keyof TBindings & string = keyof TBindings & string, const W extends BindingWith<B> = never>(
    param: TName,
    binder: B & ConsistentBinder<B>,
    options?: BindOptions<TScope, [BindingWith<B>] extends [never] ? NoRelations : readonly W[], [B] extends [{ readonly routeBindingScoped: true }] ? true : false>,
  ): Route<TState, TParams, Merge<TBindings, { [K in TName]: BoundValue<B, W> }>> {
    // Untyped code gets past the options type: a column without its parent would bind the record unscoped.
    if (options?.column !== undefined && options.scopedBy === undefined) {
      throw new Error(`Route.bind('${param}') has a column (${options.column}) but no scopedBy — name the parent parameter, or the record is looked up without it.`);
    }
    const scopedBy: unknown = options?.scopedBy;
    // The router and the access check read `scopedBy` with the same test: '', null or false must not leave a binding quietly unscoped.
    if (scopedBy !== undefined && (!isScoped({ scopedBy } as RouteBinding) || !(this.#attributes.bindings ?? []).some((bound) => bound.param === scopedBy))) {
      throw new Error(`Route.bind('${param}') is scoped by ${JSON.stringify(scopedBy)}, which is not the name of a parameter bound before it — bind the parent first: Route.bind(parent, …).bind('${param}', …, { scopedBy: parent }).`);
    }
    const binding: RouteBinding = {
      param,
      binder,
      ...(options?.scopedBy === undefined ? {} : { scopedBy: options.scopedBy, column: options.column }),
      ...(options?.public ? { public: true as const } : {}),
      ...(options?.with?.length ? { with: [...options.with] } : {}),
    };
    return this.#with({ bindings: [...(this.#attributes.bindings ?? []), binding] });
  }

  /**
   * Declares who may call every route registered through the returned registrar. It runs after the bindings (so it sees the
   * bound records) and before the request's own `authorize`, validation, interceptors and the handler; `false` answers 403.
   * Several checks all have to say yes, and `everyone` never opens a route further than another check allows.
   * See docs/routing.md#route-groups and docs/authorization.md#every-route-decides.
   */
  authorize(
    check: (ctx: RouteContext<TState, TParams, TBindings, ''>, resolve: ClassResolver) => boolean | Promise<boolean>,
  ): Route<TState, TParams, TBindings> {
    // Untyped code gets past the signature; a second check dropped silently would leave the route open to more callers.
    if (arguments.length > 1) {
      throw new TypeError(`Route.authorize() takes one check — got ${arguments.length} at ${this.#attributes.prefix}; chain them: Route.authorize(a).authorize(b).`);
    }
    // Untyped code gets past the parameter type; a check that is not callable would otherwise fail on the first request.
    if (typeof check !== 'function') {
      throw new TypeError(`Route.authorize() takes a function (ctx, resolve) => boolean — got ${typeof check} at ${this.#attributes.prefix}.`);
    }
    const holder: { stack?: string } = {};
    Error.captureStackTrace(holder, this.authorize);
    const entry: RegistrarAudit = { used: false, site: siteOf(holder.stack) };
    this.#attributes.audit?.push(entry);
    return this.#with({ checks: [...(this.#attributes.checks ?? []), check as AccessCheck], pending: [...(this.#attributes.pending ?? []), entry] });
  }

  /**
   * Every route registered through the returned registrar is internal — never sent to the browser
   * (see `RouteDefinition.internal()`): `Route.internal().prefix('/admin').group((Route) => { … })`.
   */
  internal(): Route<TState, TParams, TBindings> {
    return this.#with({ internal: true });
  }

  group(callback: (Route: this) => void): void {
    // Calling group() is use, even with an empty callback.
    for (const entry of this.#attributes.pending ?? []) entry.used = true;
    const returned: unknown = callback(this);
    if (typeof (returned as { then?: unknown } | undefined)?.then === 'function') {
      throw new Error('Route.group() takes a synchronous callback: routes registered after its first await would escape the checks made at load.');
    }
  }

  // -- Route registration ----------------------------------------------------

  /** A GET route (HEAD too). Its controller reads the URL — `query` — never a body: a request with a `schema` is a type error. */
  get<const TPath extends string, TSchema extends StandardSchemaV1 = never, TQuery extends StandardSchemaV1 = never>(
    path: TPath,
    action: GetRouteAction<TState, TParams, TBindings, TPath, TSchema, TQuery>,
  ): RouteDefinition {
    return this.#add(['GET'], path, action as unknown as AnyAction, Route.prototype.get);
  }

  post<const TPath extends string, TSchema extends StandardSchemaV1 = never, TQuery extends StandardSchemaV1 = never, TResult = unknown>(
    path: TPath,
    action: NonGetRouteAction<TState, TParams, TBindings, TPath, TSchema, TQuery, TResult>,
  ): RouteDefinition {
    return this.#add(['POST'], path, action, Route.prototype.post);
  }

  put<const TPath extends string, TSchema extends StandardSchemaV1 = never, TQuery extends StandardSchemaV1 = never, TResult = unknown>(
    path: TPath,
    action: NonGetRouteAction<TState, TParams, TBindings, TPath, TSchema, TQuery, TResult>,
  ): RouteDefinition {
    return this.#add(['PUT'], path, action, Route.prototype.put);
  }

  patch<const TPath extends string, TSchema extends StandardSchemaV1 = never, TQuery extends StandardSchemaV1 = never, TResult = unknown>(
    path: TPath,
    action: NonGetRouteAction<TState, TParams, TBindings, TPath, TSchema, TQuery, TResult>,
  ): RouteDefinition {
    return this.#add(['PATCH'], path, action, Route.prototype.patch);
  }

  delete<const TPath extends string, TSchema extends StandardSchemaV1 = never, TQuery extends StandardSchemaV1 = never, TResult = unknown>(
    path: TPath,
    action: NonGetRouteAction<TState, TParams, TBindings, TPath, TSchema, TQuery, TResult>,
  ): RouteDefinition {
    return this.#add(['DELETE'], path, action, Route.prototype.delete);
  }

  options<const TPath extends string, TSchema extends StandardSchemaV1 = never, TQuery extends StandardSchemaV1 = never, TResult = unknown>(
    path: TPath,
    action: NonGetRouteAction<TState, TParams, TBindings, TPath, TSchema, TQuery, TResult>,
  ): RouteDefinition {
    return this.#add(['OPTIONS'], path, action, Route.prototype.options);
  }

  match<const TPath extends string, TSchema extends StandardSchemaV1 = never, TQuery extends StandardSchemaV1 = never, TResult = unknown>(
    methods: readonly HttpMethod[],
    path: TPath,
    action: NonGetRouteAction<TState, TParams, TBindings, TPath, TSchema, TQuery, TResult>,
  ): RouteDefinition {
    return this.#add(methods, path, action, Route.prototype.match);
  }

  any<const TPath extends string, TSchema extends StandardSchemaV1 = never, TQuery extends StandardSchemaV1 = never, TResult = unknown>(
    path: TPath,
    action: NonGetRouteAction<TState, TParams, TBindings, TPath, TSchema, TQuery, TResult>,
  ): RouteDefinition {
    return this.#add(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], path, action, Route.prototype.any);
  }

  // -- Internals ---------------------------------------------------------------

  #with<TNextState extends object, TNextParams extends object, TNextBindings extends object>(
    attributes: Partial<GroupAttributes>,
  ): Route<TNextState, TNextParams, TNextBindings> {
    return new Route(this.#register, { ...this.#attributes, ...attributes });
  }

  #add(methods: readonly HttpMethod[], path: string, action: AnyAction | string, caller: (...args: never[]) => unknown): RouteDefinition {
    const fullPath = joinPaths(this.#attributes.prefix, path);
    // The types refuse this already; a route built without them fails at boot.
    const request = typeof action === 'function' ? (action as { request?: { schema?: unknown } }).request : undefined;
    if (request?.schema && methods.every((method) => method === 'GET' || method === 'HEAD')) {
      throw new Error(`Route GET ${fullPath}: ${GET_HAS_NO_BODY} — ${(action as { name?: string }).name || 'its controller'} has a body schema.`);
    }
    const problem = patternProblem(fullPath);
    if (problem) throw new Error(withCode('H13', `${problem} See docs/routing.md#parameter-names.`));
    const names = new Set(tokenizePattern(fullPath).flatMap((token) => ('name' in token ? [token.name] : [])));
    const bindings = this.#attributes.bindings ?? [];
    for (const { param } of bindings) {
      // The types already refuse this; a route built without them (plain JS) fails here, at boot.
      if (!names.has(param)) throw new Error(`Route.bind('${param}') needs a :${param} parameter in ${fullPath}.`);
    }
    const route = new RouteDefinition({
      methods,
      path: fullPath,
      action: action as AnyAction,
      middleware: this.#attributes.middleware,
      namePrefix: this.#attributes.namePrefix,
      group: this.#attributes.group,
      bindings,
      checks: this.#attributes.checks ?? [],
      site: registrationSite(caller),
      internal: this.#attributes.internal ?? false,
      localized: this.#attributes.localized ?? false,
    });
    for (const entry of this.#attributes.pending ?? []) entry.used = true;
    this.#register(route);
    return route;
  }
}

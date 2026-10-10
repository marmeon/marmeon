import type { BodyOf, RequestDefinition, StandardSchemaV1, WithQuery } from './request-definition.ts';
import type { RequestState } from './request.ts';
import type { RouteDefinition } from './route-definition.ts';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export type EmptyObject = {};

/** Flattens intersections so editor tooltips show `{ id: string; user: User }` instead of `A & B`. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Right-biased merge: keys in `B` override keys in `A`. */
export type Merge<A, B> = Simplify<Omit<A, keyof B> & B>;

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

/** `id`, `id?` or `id{[0-9]+}` -> `{ id: string }` / `{ id?: string }`. */
type ParamEntry<Segment extends string> = Segment extends `${infer Name}{${string}}`
  ? ParamEntry<Name>
  : Segment extends `${infer Name}?`
    ? { [K in Name]?: string }
    : { [K in Segment]: string };

/**
 * Extracts typed parameters from a Hono-style path.
 *
 * @example ExtractParams<'/teams/:team/users/:id?'> // { team: string; id?: string }
 */
export type ExtractParams<Path extends string> = Path extends `${string}:${infer Segment}/${infer Rest}`
  ? ParamEntry<Segment> & ExtractParams<`/${Rest}`>
  : Path extends `${string}:${infer Segment}`
    ? ParamEntry<Segment>
    : EmptyObject;

// ---------------------------------------------------------------------------
// Context & middleware
// ---------------------------------------------------------------------------

/** What every handler and middleware gets: the raw request, its route and parameters, plus query, input and cookies. */
export interface RequestContext<TParams extends object = EmptyObject> extends RequestState {
  readonly request: Request;
  readonly params: TParams;
  readonly route: RouteDefinition;
}

/**
 * What a handler or middleware receives: the request context plus everything
 * that upstream middleware added via `next({ ... })`.
 */
export type HttpContext<TState extends object = EmptyObject, TParams extends object = EmptyObject> = RequestContext<TParams> & TState;

/** Middleware that adds nothing may call `next()`; otherwise the extension is mandatory. */
export type Next<TAdd extends object> = keyof TAdd extends never
  ? (extension?: TAdd) => Promise<Response>
  : (extension: TAdd) => Promise<Response>;

/**
 * A pipeline stage. `TRequires` is the context it needs from earlier middleware,
 * `TAdds` is what it contributes to later middleware and the final handler.
 *
 * `handle` is a property, not a method: property function types are checked contravariantly under
 * `strictFunctionTypes`, so middleware whose requirements are unmet is a compile error.
 */
export interface MiddlewareHandler<TRequires extends object = EmptyObject, TAdds extends object = EmptyObject> {
  readonly handle: (ctx: HttpContext<TRequires>, next: Next<TAdds>) => Response | Promise<Response>;
  /**
   * Runs after the response has been handed off — for work the client should not
   * wait for (cleanup, metrics). Errors are logged, never sent.
   */
  readonly terminate?: (ctx: HttpContext<TRequires>, response: Response) => void | Promise<void>;
}

/** Middleware as a plain object, from `defineMiddleware`. */
export interface Middleware<TRequires extends object = EmptyObject, TAdds extends object = EmptyObject>
  extends MiddlewareHandler<TRequires, TAdds> {
  readonly name: string;
}

/**
 * Middleware as a class: built per request from the container, so it gets
 * constructor injection like a controller. See docs/middleware.md#middleware-classes.
 */
export type MiddlewareClass<TRequires extends object = any, TAdds extends object = any> = new (
  ...args: any[]
) => MiddlewareHandler<TRequires, TAdds>;

export type MiddlewareLike<TRequires extends object = EmptyObject, TAdds extends object = EmptyObject> =
  | Middleware<TRequires, TAdds>
  | MiddlewareClass<TRequires, TAdds>;

export type AnyMiddleware = MiddlewareLike<any, any>;

// ---------------------------------------------------------------------------
// Actions (closures & invokable controllers)
// ---------------------------------------------------------------------------

export type Handler<TCtx, TResult = unknown> = (ctx: TCtx) => TResult;

/**
 * What a controller instance must offer to serve a route with context `TCtx`. `handle` is a property, so a controller
 * that needs more context than the route provides is a compile error (checked contravariantly).
 */
export interface Invokable<TCtx, TResult = unknown> {
  readonly handle: (ctx: TCtx) => TResult;
}

/**
 * An invokable controller (REPR): one class per endpoint, one `handle(ctx)`.
 * Constructor arguments are the container's concern.
 *
 * With `static request = defineRequest(…)`, `authorize(ctx)` must accept the route's context, and `handle` gets it
 * plus the validated `body` and the parsed `query`. One type with an optional `request`: a union of "with" and
 * "without request" lets an `authorize` that needs more context slip through the "without" branch.
 */
export type ControllerClass<TCtx = any, TSchema extends StandardSchemaV1 = any, TQuery extends StandardSchemaV1 = any, TResult = unknown> = (new (
  ...args: any[]
) => Invokable<WithQuery<TCtx, TQuery> & BodyOf<TSchema>, TResult>) & {
  readonly request?: RequestDefinition<TSchema, TCtx, TQuery>;
};

// ---------------------------------------------------------------------------
// Route binding
// ---------------------------------------------------------------------------

/**
 * Turns a route parameter into what the controller works with (Laravel's route model binding).
 * The router stays free of any database: repositories — or any injectable class — implement it.
 * Returning `undefined` answers 404.
 */
export interface RouteBinder<T> {
  resolveRouteBinding(value: string, binding: RouteBindingContext): T | undefined | Promise<T | undefined>;
}

export interface RouteBindingContext {
  readonly ctx: HttpContext<any, any>;
  /** Scoped bindings (`{ scopedBy: 'team' }`): the parent it must belong to, and the column that points at it. */
  readonly scope?: { readonly param: string; readonly parent: unknown; readonly column: string };
}

/** A class that binds route parameters — built per request from the container. */
export type RouteBinderClass<T = unknown> = new (...args: any[]) => RouteBinder<T>;

/** What a binder class resolves to. */
export type BoundValue<B> = B extends new (...args: any[]) => RouteBinder<infer T> ? T : never;

/**
 * A binder class with a static `table` (a repository) must name the table its instances are typed for —
 * `static table = 'articles'` on a `Repository<'users'>` is caught here.
 */
export type ConsistentBinder<B> = B extends { readonly table: infer S }
  ? InstanceType<B & (new (...args: any[]) => unknown)> extends { readonly table: infer I }
    ? [S] extends [I]
      ? unknown
      : { readonly table: { expected: I } } // an object, so the message names it (two literals would collapse to never)
    : unknown
  : unknown;

export interface RouteBinding {
  readonly param: string;
  readonly binder: RouteBinderClass;
  readonly scopedBy?: string;
  readonly column?: string;
}

/** Builds controller and middleware classes — per request, from the container. */
export type ClassResolver = <T>(Class: new (...args: any[]) => T) => T;

/**
 * A closure or a controller class. `TSchema` and `TQuery` are inferred from the controller's `request` (`never` without
 * them), `TResult` from what it returns (the routes of other methods than GET refuse an island, see `Route.post`).
 */
export type Action<TCtx, TSchema extends StandardSchemaV1 = never, TQuery extends StandardSchemaV1 = never, TResult = unknown> =
  | Handler<TCtx, TResult>
  | ControllerClass<TCtx, TSchema, TQuery, TResult>;

/**
 * What a region result carries — `this.island(…)` of @marmeon/http — so the router can tell an island's controller
 * by its type alone (it never imports http): islands are GET routes, `<Island route>` takes only them, `<Link>` none.
 */
export interface RegionResultMarker {
  readonly region: 'island';
}

/**
 * What a layer result carries — `this.view(…).layer({ base })` of @marmeon/http — so the router's types can tell a
 * layer route by its controller alone: `<Link layer>` takes only them.
 */
export interface LayerResultMarker {
  readonly region: 'layer';
}

export type AnyAction = Action<any, any, any>;

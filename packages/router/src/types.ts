import type { BodyOf, RequestDefinition, StandardSchemaV1 } from './request-definition.ts';
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
 * `handle` is declared as a property (not a method) on purpose: property
 * function types are checked contravariantly under `strictFunctionTypes`, which
 * is what lets the compiler reject middleware whose requirements are unmet —
 * even when a middleware class writes `handle` as an ordinary method.
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
 * constructor injection like a controller.
 *
 * ```ts
 * export class Authenticate {
 *   constructor(users: UserRepository) { … }
 *   handle(ctx: HttpContext, next: Next<AuthState>) { … }
 * }
 * ```
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

export type Handler<TCtx> = (ctx: TCtx) => unknown;

/**
 * What a controller instance must offer to serve a route with context `TCtx`.
 *
 * `handle` is declared as a property on purpose: even when a controller writes
 * `handle(ctx)` as a method, TypeScript compares it against this *property*
 * strictly (contravariantly), so a controller that needs more context than
 * the route provides is a compile error.
 */
export interface Invokable<TCtx> {
  readonly handle: (ctx: TCtx) => unknown;
}

/**
 * An invokable controller (REPR): one class per endpoint, one `handle(ctx)`.
 * Constructor arguments are the container's concern.
 *
 * With `static request = defineRequest(…)`, the route checks both halves against
 * its context: `authorize(ctx)` must accept the route's context, and `handle`
 * gets it plus the validated `body`. *One* type with an optional `request` on
 * purpose: a union of "with" and "without request" let a controller whose
 * `authorize` needs more context than the route has slip through the "without"
 * branch — and made TypeScript explain the wrong branch (type spike for E13).
 */
export type ControllerClass<TCtx = any, TSchema extends StandardSchemaV1 = any> = (new (
  ...args: any[]
) => Invokable<TCtx & BodyOf<TSchema>>) & {
  readonly request?: RequestDefinition<TSchema, TCtx>;
};

/** Builds controller and middleware classes — per request, from the container. */
export type ClassResolver = <T>(Class: new (...args: any[]) => T) => T;

/** A closure or a controller class. `TSchema` is inferred from the controller's `request` (`never` without one). */
export type Action<TCtx, TSchema extends StandardSchemaV1 = never> = Handler<TCtx> | ControllerClass<TCtx, TSchema>;

export type AnyAction = Action<any, any>;

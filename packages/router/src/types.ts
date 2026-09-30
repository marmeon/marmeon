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

export interface RequestContext<TParams extends object = EmptyObject> {
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
 * is what lets the compiler reject middleware whose requirements are unmet.
 */
export interface Middleware<TRequires extends object = EmptyObject, TAdds extends object = EmptyObject> {
  readonly name: string;
  readonly handle: (ctx: HttpContext<TRequires>, next: Next<TAdds>) => Response | Promise<Response>;
}

export type AnyMiddleware = Middleware<any, any>;

// ---------------------------------------------------------------------------
// Actions (closures & controller tuples)
// ---------------------------------------------------------------------------

export type Handler<TCtx> = (ctx: TCtx) => unknown;

export type ControllerClass<TController = unknown> = new (...args: any[]) => TController;

/**
 * Method names of `C` that can be called with `TCtx`. The check runs on the
 * parameter type (not the method type) to avoid method-parameter bivariance.
 */
export type ControllerMethod<C, TCtx> = {
  [K in keyof C]-?: C[K] extends (...args: any[]) => unknown
    ? Parameters<C[K]> extends []
      ? K
      : TCtx extends Parameters<C[K]>[0]
        ? K
        : never
    : never;
}[keyof C] &
  string;

/** Laravel-style `[UserController, 'show']`. */
export type ControllerAction<C, TCtx> = readonly [ControllerClass<C>, ControllerMethod<C, TCtx>];

export type Action<C, TCtx> = Handler<TCtx> | ControllerAction<C, TCtx>;

export type AnyAction = Handler<any> | readonly [ControllerClass, string];

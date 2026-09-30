import { RouteDefinition } from './route-definition.ts';
import type { StandardSchemaV1 } from './request-definition.ts';
import type {
  Action,
  AnyAction,
  AnyMiddleware,
  EmptyObject,
  ExtractParams,
  HttpContext,
  HttpMethod,
  Merge,
  MiddlewareLike,
  Simplify,
} from './types.ts';

export interface GroupAttributes {
  readonly prefix: string;
  readonly namePrefix: string;
  readonly middleware: readonly AnyMiddleware[];
  /** Middleware group of every route registered through this registrar (`web`, `api`). */
  readonly group?: string | undefined;
}

type RouteContext<TState extends object, TParams extends object, TPath extends string> = HttpContext<
  TState,
  Simplify<TParams & ExtractParams<TPath>>
>;

export function joinPaths(...segments: string[]): string {
  const parts = segments.flatMap((segment) => segment.split('/')).filter(Boolean);
  return `/${parts.join('/')}`;
}

/**
 * Fluent, immutable route registrar (Laravel's `RouteRegistrar`).
 *
 * Every attribute call returns a *new* registrar, so the accumulated context
 * type (`TState`) and path parameters (`TParams`) flow into nested groups:
 *
 * ```ts
 * Route.prefix('/teams/:team').middleware(authenticate).name('teams.').group((Route) => {
 *   Route.get('/members/:id', (ctx) => ctx.user + ctx.params.team + ctx.params.id).name('members.show');
 * });
 * ```
 */
export class Route<TState extends object = EmptyObject, TParams extends object = EmptyObject> {
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

  prefix<const TPath extends string>(path: TPath): Route<TState, Simplify<TParams & ExtractParams<TPath>>> {
    return this.#with({ prefix: joinPaths(this.#attributes.prefix, path) });
  }

  /** Prefix for route names in this group, e.g. `name('admin.')`. */
  name(prefix: string): Route<TState, TParams> {
    return this.#with({ namePrefix: this.#attributes.namePrefix + prefix });
  }

  /**
   * Appends middleware. It must accept the context built so far, and whatever it
   * passes to `next()` becomes available to everything registered after it.
   */
  middleware<TAdds extends object>(middleware: MiddlewareLike<TState, TAdds>): Route<Merge<TState, TAdds>, TParams> {
    return this.#with({ middleware: [...this.#attributes.middleware, middleware] });
  }

  group(callback: (Route: this) => void): void {
    callback(this);
  }

  // -- Route registration ----------------------------------------------------

  get<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: Action<RouteContext<TState, TParams, TPath>, TSchema>,
  ): RouteDefinition {
    return this.#add(['GET'], path, action);
  }

  post<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: Action<RouteContext<TState, TParams, TPath>, TSchema>,
  ): RouteDefinition {
    return this.#add(['POST'], path, action);
  }

  put<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: Action<RouteContext<TState, TParams, TPath>, TSchema>,
  ): RouteDefinition {
    return this.#add(['PUT'], path, action);
  }

  patch<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: Action<RouteContext<TState, TParams, TPath>, TSchema>,
  ): RouteDefinition {
    return this.#add(['PATCH'], path, action);
  }

  delete<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: Action<RouteContext<TState, TParams, TPath>, TSchema>,
  ): RouteDefinition {
    return this.#add(['DELETE'], path, action);
  }

  options<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: Action<RouteContext<TState, TParams, TPath>, TSchema>,
  ): RouteDefinition {
    return this.#add(['OPTIONS'], path, action);
  }

  match<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    methods: readonly HttpMethod[],
    path: TPath,
    action: Action<RouteContext<TState, TParams, TPath>, TSchema>,
  ): RouteDefinition {
    return this.#add(methods, path, action);
  }

  any<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: Action<RouteContext<TState, TParams, TPath>, TSchema>,
  ): RouteDefinition {
    return this.#add(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], path, action);
  }

  // -- Internals ---------------------------------------------------------------

  #with<TNextState extends object, TNextParams extends object>(
    attributes: Partial<GroupAttributes>,
  ): Route<TNextState, TNextParams> {
    return new Route(this.#register, { ...this.#attributes, ...attributes });
  }

  #add(methods: readonly HttpMethod[], path: string, action: AnyAction): RouteDefinition {
    const route = new RouteDefinition({
      methods,
      path: joinPaths(this.#attributes.prefix, path),
      action,
      middleware: this.#attributes.middleware,
      namePrefix: this.#attributes.namePrefix,
      group: this.#attributes.group,
    });
    this.#register(route);
    return route;
  }
}

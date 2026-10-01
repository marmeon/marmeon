import { RouteDefinition } from './route-definition.ts';
import type { StandardSchemaV1 } from './request-definition.ts';
import type {
  Action,
  AnyAction,
  AnyMiddleware,
  BoundValue,
  ConsistentBinder,
  EmptyObject,
  ExtractParams,
  HttpContext,
  HttpMethod,
  Merge,
  MiddlewareLike,
  RouteBinderClass,
  RouteBinding,
  Simplify,
} from './types.ts';

export interface GroupAttributes {
  readonly prefix: string;
  readonly namePrefix: string;
  readonly middleware: readonly AnyMiddleware[];
  /** Middleware group of every route registered through this registrar (`web`, `api`). */
  readonly group?: string | undefined;
  readonly bindings?: readonly RouteBinding[];
  /** Every route of the group is internal: never sent to the browser (`RouteDefinition.internal()`). */
  readonly internal?: boolean;
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
type RouteAction<TState extends object, TParams extends object, TBindings extends object, TPath extends string, TSchema extends StandardSchemaV1> =
  Exclude<keyof TBindings, keyof (TParams & ExtractParams<TPath>)> extends infer Missing extends PropertyKey
    ? [Missing] extends [never]
      ? Action<RouteContext<TState, TParams, TBindings, TPath>, TSchema>
      : `Route.bind('${Missing & string}') needs a :${Missing & string} parameter in the path`
    : never;

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

  /** Prefix for route names in this group, e.g. `name('admin.')`. */
  name(prefix: string): Route<TState, TParams, TBindings> {
    return this.#with({ namePrefix: this.#attributes.namePrefix + prefix });
  }

  /**
   * Appends middleware. It must accept the context built so far, and whatever it
   * passes to `next()` becomes available to everything registered after it.
   */
  middleware<TAdds extends object>(middleware: MiddlewareLike<TState, TAdds>): Route<Merge<TState, TAdds>, TParams, TBindings> {
    return this.#with({ middleware: [...this.#attributes.middleware, middleware] });
  }

  /**
   * Resolves the route parameter `param` with `binder` (Laravel's route model binding): the action
   * gets the record instead of the string, a missing one answers 404. Registered before the route,
   * like middleware, so the type reaches `handle`:
   *
   * ```ts
   * Route.bind('user', UserRepository).get('/users/:user', ShowUserController);   // ctx.params.user: User
   * Route.bind('team', TeamRepository)
   *   .bind('member', MemberRepository, { scopedBy: 'team' })                     // must belong to the team
   *   .get('/teams/:team/members/:member', ShowMemberController);
   * ```
   *
   * Scoped bindings look the child up *within* its parent (`team_id = team.id`, or `column`), so an id
   * from somewhere else is a 404 — insecure direct object references cannot happen by forgetting a check.
   */
  bind<const TName extends string, B extends RouteBinderClass<unknown>, const TScope extends keyof TBindings & string = never>(
    param: TName,
    binder: B & ConsistentBinder<B>,
    options?: { scopedBy: TScope; column?: string },
  ): Route<TState, TParams, Merge<TBindings, { [K in TName]: BoundValue<B> }>> {
    const binding: RouteBinding = { param, binder, ...(options ? { scopedBy: options.scopedBy, column: options.column } : {}) };
    return this.#with({ bindings: [...(this.#attributes.bindings ?? []), binding] });
  }

  /**
   * Every route registered through the returned registrar is internal — never sent to the browser
   * (see `RouteDefinition.internal()`): `Route.internal().prefix('/admin').group((Route) => { … })`.
   */
  internal(): Route<TState, TParams, TBindings> {
    return this.#with({ internal: true });
  }

  group(callback: (Route: this) => void): void {
    callback(this);
  }

  // -- Route registration ----------------------------------------------------

  get<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: RouteAction<TState, TParams, TBindings, TPath, TSchema>,
  ): RouteDefinition {
    return this.#add(['GET'], path, action);
  }

  post<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: RouteAction<TState, TParams, TBindings, TPath, TSchema>,
  ): RouteDefinition {
    return this.#add(['POST'], path, action);
  }

  put<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: RouteAction<TState, TParams, TBindings, TPath, TSchema>,
  ): RouteDefinition {
    return this.#add(['PUT'], path, action);
  }

  patch<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: RouteAction<TState, TParams, TBindings, TPath, TSchema>,
  ): RouteDefinition {
    return this.#add(['PATCH'], path, action);
  }

  delete<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: RouteAction<TState, TParams, TBindings, TPath, TSchema>,
  ): RouteDefinition {
    return this.#add(['DELETE'], path, action);
  }

  options<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: RouteAction<TState, TParams, TBindings, TPath, TSchema>,
  ): RouteDefinition {
    return this.#add(['OPTIONS'], path, action);
  }

  match<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    methods: readonly HttpMethod[],
    path: TPath,
    action: RouteAction<TState, TParams, TBindings, TPath, TSchema>,
  ): RouteDefinition {
    return this.#add(methods, path, action);
  }

  any<const TPath extends string, TSchema extends StandardSchemaV1 = never>(
    path: TPath,
    action: RouteAction<TState, TParams, TBindings, TPath, TSchema>,
  ): RouteDefinition {
    return this.#add(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], path, action);
  }

  // -- Internals ---------------------------------------------------------------

  #with<TNextState extends object, TNextParams extends object, TNextBindings extends object>(
    attributes: Partial<GroupAttributes>,
  ): Route<TNextState, TNextParams, TNextBindings> {
    return new Route(this.#register, { ...this.#attributes, ...attributes });
  }

  #add(methods: readonly HttpMethod[], path: string, action: AnyAction | string): RouteDefinition {
    const fullPath = joinPaths(this.#attributes.prefix, path);
    const bindings = this.#attributes.bindings ?? [];
    for (const { param } of bindings) {
      // The types already refuse this; a route built without them (plain JS) fails here, at boot.
      if (!new RegExp(`/:${param}(\\{[^}]*\\})?\\??(/|$)`).test(fullPath)) throw new Error(`Route.bind('${param}') needs a :${param} parameter in ${fullPath}.`);
    }
    const route = new RouteDefinition({
      methods,
      path: fullPath,
      action: action as AnyAction,
      middleware: this.#attributes.middleware,
      namePrefix: this.#attributes.namePrefix,
      group: this.#attributes.group,
      bindings,
      internal: this.#attributes.internal ?? false,
    });
    this.#register(route);
    return route;
  }
}

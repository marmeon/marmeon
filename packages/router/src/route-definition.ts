import type { AnyAction, AnyMiddleware, HttpMethod, RouteBinding } from './types.ts';

/**
 * A single registered route (Laravel's `Illuminate\Routing\Route`).
 * Created by the `Route` registrar; only its name remains mutable after registration.
 */
export class RouteDefinition {
  readonly methods: readonly HttpMethod[];
  readonly path: string;
  readonly action: AnyAction;
  /** The route's own middleware; group and global middleware run before it (`Router.middlewareFor`). */
  readonly middleware: readonly AnyMiddleware[];
  /** The middleware group the route belongs to, e.g. `web` or `api`. */
  readonly group: string | undefined;
  /** Route parameters resolved to records before the action runs (`Route.bind`). */
  readonly bindings: readonly RouteBinding[];
  readonly #namePrefix: string;
  #name: string | undefined;
  #internal: boolean;

  constructor(options: {
    methods: readonly HttpMethod[];
    path: string;
    action: AnyAction;
    middleware: readonly AnyMiddleware[];
    namePrefix: string;
    group?: string | undefined;
    bindings?: readonly RouteBinding[];
    internal?: boolean;
  }) {
    this.methods = options.methods;
    this.path = options.path;
    this.action = options.action;
    this.middleware = options.middleware;
    this.group = options.group;
    this.bindings = options.bindings ?? [];
    this.#namePrefix = options.namePrefix;
    this.#internal = options.internal ?? false;
  }

  /** Names the route, prepending any group name prefix: `name('show')` in `name('profile.')` -> `profile.show`. */
  name(name: string): this {
    this.#name = this.#namePrefix + name;
    return this;
  }

  get routeName(): string | undefined {
    return this.#name;
  }

  /**
   * Keeps the route out of the browser for good: `bespoke route:types` marks it `browser: false`, so naming it in
   * client code is a compile error, and it never enters the browser's route manifest — not even when client code
   * names it or `clientRoutes.include` matches it. For routes only the server links to, e.g. a signed link it sends by mail:
   *
   * ```ts
   * Route.get('/email/verify/:id/:hash', VerifyEmailController).name('verification.verify').internal();
   * Route.internal().prefix('/admin').name('admin.').group((Route) => { … });   // a whole group
   * ```
   */
  internal(): this {
    this.#internal = true;
    return this;
  }

  /** Whether {@link internal} applies, to the route or its group. */
  get isInternal(): boolean {
    return this.#internal;
  }
}

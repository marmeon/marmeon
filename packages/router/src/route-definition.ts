import type { AnyAction, AnyMiddleware, HttpMethod, RouteBinding } from './types.ts';

/**
 * A single registered route.
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
  #blocking: RouteBlocking | undefined;

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
   * Keeps the route out of the browser for good: `marmeon route:types` marks it `browser: false`, so naming it in
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

  /**
   * Runs the route's requests one at a time per session: `StartSession` holds an atomic lock (needs
   * `@marmeon/cache`) from loading the session until it is saved. A second request of the same browser waits up to
   * `waitSeconds` (then 423); a crashed request's lock expires after `lockSeconds`. See docs/routing.md#one-request-at-a-time.
   *
   * ```ts
   * Route.post('/cart/checkout', CheckoutController).name('cart.checkout').block();       // 10 s lock, waits up to 10 s
   * Route.post('/wizard/step', WizardStepController).block(5, 2);
   * ```
   */
  block(lockSeconds = 10, waitSeconds: number = lockSeconds): this {
    for (const [what, value] of [['lockSeconds', lockSeconds], ['waitSeconds', waitSeconds]] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new TypeError(`block(): ${what} must be a positive number of seconds (got ${value}) — ${this.path}.`);
    }
    this.#blocking = { lockSeconds, waitSeconds };
    return this;
  }

  /** The session lock {@link block} asks for — undefined for a route that does not block. */
  get blocking(): RouteBlocking | undefined {
    return this.#blocking;
  }
}

/** What {@link RouteDefinition.block} asks for: hold the session's lock at most `lockSeconds`, wait for it at most `waitSeconds`. */
export interface RouteBlocking {
  readonly lockSeconds: number;
  readonly waitSeconds: number;
}

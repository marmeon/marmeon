import type { AccessCheck } from './access.ts';
import type { AnyAction, AnyMiddleware, HttpMethod, RouteBinding } from './types.ts';

/**
 * A single registered route.
 * Created by the `Route` registrar; its name, `internal()` and `block()` can be set until the router loads it.
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
  declare readonly bindings: readonly RouteBinding[];
  /** The registrar's `authorize` checks, in declaration order; they run after the bindings and before anything else answers. */
  declare readonly checks: readonly AccessCheck[];
  /** @internal Where the route was registered, as `file:line` — for the messages about routes that do not say who may call them. */
  declare readonly site: string | undefined;
  readonly #namePrefix: string;
  #name: string | undefined;
  /** @internal Set by `Router.load` for a framework route under `/_marmeon/`, which the server registers before all others. */
  reserved = false;
  #internal: boolean;
  #blocking: RouteBlocking | undefined;
  #sealed = false;

  constructor(options: {
    methods: readonly HttpMethod[];
    path: string;
    action: AnyAction;
    middleware: readonly AnyMiddleware[];
    namePrefix: string;
    group?: string | undefined;
    bindings?: readonly RouteBinding[];
    checks?: readonly AccessCheck[];
    site?: string | undefined;
    internal?: boolean;
  }) {
    // Frozen copies: a middleware reaching `ctx.route` cannot add a method or take a middleware out for every later request.
    this.methods = Object.freeze([...options.methods]);
    this.path = options.path;
    this.action = options.action;
    this.middleware = Object.freeze([...options.middleware]);
    this.group = options.group;
    // Frozen like the checks: a binding cannot be unscoped or made public once the route is registered.
    Object.defineProperty(this, 'bindings', {
      value: Object.freeze((options.bindings ?? []).map((binding) => Object.freeze({ ...binding, ...(binding.with ? { with: Object.freeze([...binding.with]) } : {}) }))),
      writable: false,
      enumerable: true,
    });
    // Not writable and frozen: a check cannot be removed once the route is registered.
    Object.defineProperty(this, 'checks', { value: Object.freeze([...(options.checks ?? [])]), writable: false, enumerable: true });
    this.site = options.site;
    this.#namePrefix = options.namePrefix;
    this.#internal = options.internal ?? false;
  }

  /** Names the route, prepending any group name prefix: `name('show')` in `name('profile.')` -> `profile.show`. */
  name(name: string): this {
    this.#assertOpen('name');
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
    this.#assertOpen('internal');
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
    this.#assertOpen('block');
    for (const [what, value] of [['lockSeconds', lockSeconds], ['waitSeconds', waitSeconds]] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new TypeError(`block(): ${what} must be a positive number of seconds (got ${value}) — ${this.path}.`);
    }
    this.#blocking = { lockSeconds, waitSeconds };
    return this;
  }

  /**
   * Called by `Router.load` once the route passed its checks: the route and what it holds can no longer change, so nothing a
   * request runs (`ctx.route`) alters it for the requests after.
   *
   * @internal
   */
  seal(): void {
    this.#sealed = true;
    Object.freeze(this);
  }

  #assertOpen(method: string): void {
    if (this.#sealed) throw new TypeError(`${method}() cannot change a route after its routes were loaded: ${this.path}.`);
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

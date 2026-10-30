import { durationToSeconds, type Duration } from '@marmeon/core';
import { registrationSite, type AccessCheck, type AfterAuthorizeHook } from './access.ts';
import type { CheckAttachment, RouteAttachment } from './attach.ts';
import { tokenizePattern } from './pattern.ts';
import type { Route } from './route.ts';
import type { AnyAction, AnyMiddleware, HttpMethod, RouteBinding } from './types.ts';

/**
 * A single registered route.
 * Created by the `Route` registrar; its name, `internal()` and `block()` can be set until the router loads it.
 */
export class RouteDefinition<TContext extends object = any> {
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
  /** @internal The registrar's `afterAuthorize` hooks, in declaration order; they run once every check has passed. */
  declare readonly afterAuthorize: readonly AfterAuthorizeHook[];
  /** @internal Where the route was registered, as `file:line` — for the messages about routes that do not say who may call them. */
  declare readonly site: string | undefined;
  /** Whether the route lives under `/:locale` (`Route.localized()`); the server limits the segment to the app's locales. */
  readonly localized: boolean;
  /** @internal The localized route this one stands in for: the same page without the locale, which redirects to it. */
  readonly generatedFrom: RouteDefinition | undefined;
  readonly #namePrefix: string;
  #name: string | undefined;
  /** @internal Set by `Router.load` for a framework route under `/_marmeon/`, which the server registers before all others. */
  reserved = false;
  #internal: boolean;
  #sitemap = false;
  #blocking: RouteBlocking | undefined;
  #sealed = false;
  #attacher: ((page: RouteDefinition, site: string | undefined) => Route<any, any, any>) | undefined;

  /** @internal — built by `Route` when a route file registers a route. */
  constructor(options: {
    methods: readonly HttpMethod[];
    path: string;
    action: AnyAction;
    middleware: readonly AnyMiddleware[];
    namePrefix: string;
    group?: string | undefined;
    bindings?: readonly RouteBinding[];
    checks?: readonly AccessCheck[];
    afterAuthorize?: readonly AfterAuthorizeHook[];
    site?: string | undefined;
    internal?: boolean;
    localized?: boolean;
    /** @internal */
    generatedFrom?: RouteDefinition | undefined;
    /** @internal The registrar of `attach()`: the page's attributes, its path as the prefix and its whole access as the checks. */
    attacher?: (page: RouteDefinition, site: string | undefined) => Route<any, any, any>;
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
    // Frozen the same way: a hook cannot be taken out, nor one added, once the route is registered.
    Object.defineProperty(this, 'afterAuthorize', { value: Object.freeze([...(options.afterAuthorize ?? [])]), writable: false, enumerable: true });
    this.site = options.site;
    this.localized = options.localized ?? false;
    this.generatedFrom = options.generatedFrom;
    this.#namePrefix = options.namePrefix;
    this.#internal = options.internal ?? false;
    this.#attacher = options.attacher;
  }

  /** Names the route, prepending any group name prefix: `name('show')` in `name('profile.')` -> `profile.show`. */
  name(name: string): this {
    this.#assertOpen('name');
    this.#name = this.#namePrefix + name;
    return this;
  }

  /** @internal The name the router and the CLI list the route by. */
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

  /**
   * Lists the route in `/sitemap.xml`. A route with parameters needs a `sitemap()` method on its controller, which says which
   * parameters are pages. Only a `GET` page anyone may open qualifies; the start stops on any other. See docs/seo.md#sitemap-and-robotstxt.
   *
   * ```ts
   * Route.get('/about', ShowAboutController).name('about.index').sitemap();
   * ```
   */
  sitemap(): this {
    this.#assertOpen('sitemap');
    this.#sitemap = true;
    return this;
  }

  /** @internal Whether {@link sitemap} marked the route. */
  get inSitemap(): boolean {
    return this.#sitemap;
  }

  /** @internal Whether {@link internal} applies, to the route or its group. */
  get isInternal(): boolean {
    return this.#internal;
  }

  /**
   * Runs the route's requests one at a time per session: `StartSession` holds an atomic lock (needs
   * `@marmeon/cache`) from loading the session until it is saved. A second request of the same browser waits up to
   * `wait` (then 423, default: as long as `lock`); a crashed request's lock expires after `lock` (default 10 s). Both are seconds, or
   * `{ seconds: 5 }`. See docs/routing.md#one-request-at-a-time.
   *
   * ```ts
   * Route.post('/cart/checkout', CheckoutController).name('cart.checkout').block();       // 10 s lock, waits up to 10 s
   * Route.post('/wizard/step', WizardStepController).block({ lock: 5, wait: { seconds: 2 } });
   * ```
   */
  block(options: { lock?: Duration; wait?: Duration } = {}): this {
    this.#assertOpen('block');
    // Not a type error to an untyped caller: `block(5, 2)` would otherwise read as the defaults.
    const keys = typeof options === 'object' && options !== null && !Array.isArray(options) ? Object.keys(options) : undefined;
    if (arguments.length > 1 || keys === undefined || keys.some((key) => key !== 'lock' && key !== 'wait')) {
      throw new TypeError(`block() takes { lock, wait } — e.g. block({ lock: 5, wait: 2 }) (got ${JSON.stringify(options)}) — ${this.path}.`);
    }
    const { lock = 10, wait = lock } = options;
    const [lockSeconds, waitSeconds] = [lock, wait].map((value, i) => {
      const seconds = durationToSeconds(value);
      if (seconds <= 0) throw new TypeError(`block(): ${i === 0 ? 'lock' : 'wait'} must be a positive span of time (got ${JSON.stringify(value)}) — ${this.path}.`);
      return seconds;
    }) as [number, number];
    this.#blocking = { lockSeconds, waitSeconds };
    return this;
  }

  /**
   * Hangs the routes a package makes for this page under its path, such as an exporter's routes. They carry the page's middleware,
   * bindings, checks and its request's `authorize`; an attachment can add to these, never take one away. See docs/routing.md#routes-under-a-page.
   *
   * ```ts
   * Route.get('/audit', ListAuditController).attach(csvExport);
   * ```
   */
  attach<A extends RouteAttachment<any>>(attachment: A & CheckAttachment<A, Omit<TContext, 'query'>>): this {
    this.#assertOpen('attach');
    const attachTo = (attachment as Partial<RouteAttachment> | null | undefined)?.attachTo;
    if (typeof attachTo !== 'function') {
      throw new TypeError(`attach() takes what a package makes for a page, such as a route attachment — got ${describeValue(attachment)} — ${this.path}.`);
    }
    if (this.methods.length !== 1 || this.methods[0] !== 'GET') {
      throw new TypeError(`attach() hangs routes on a page, a GET route — ${this.methods.join('|')} ${this.path} is none.`);
    }
    if (tokenizePattern(this.path).some((token) => 'optional' in token && token.optional)) {
      throw new TypeError(`attach(): ${this.path} has an optional parameter — the routes under the page would have none to fill. Give the page a path without one.`);
    }
    const attacher = this.#attacher;
    if (!attacher) throw new TypeError(`attach() needs a route registered through Route — ${this.methods.join('|')} ${this.path} was built by hand.`);
    // The caller's frame: the routes name the app's route file in a message, not the package that registered them.
    const site = registrationSite(RouteDefinition.prototype.attach);
    const returned: unknown = attachTo.call(attachment, attacher(this, site), this);
    if (typeof (returned as { then?: unknown } | undefined)?.then === 'function') {
      throw new Error('attach() takes a synchronous attachTo: routes registered after its first await would escape the checks made at load.');
    }
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
    this.#attacher = undefined;
    Object.freeze(this);
  }

  #assertOpen(method: string): void {
    if (this.#sealed) throw new TypeError(`${method}() cannot change a route after its routes were loaded: ${this.path}.`);
  }

  /** @internal The session lock {@link block} asks for — undefined for a route that does not block. */
  get blocking(): RouteBlocking | undefined {
    return this.#blocking;
  }
}

function describeValue(value: unknown): string {
  return typeof value === 'object' && value !== null ? 'an object without attachTo' : typeof value;
}

/** What {@link RouteDefinition.block} asks for: hold the session's lock at most `lockSeconds`, wait for it at most `waitSeconds`. */
export interface RouteBlocking {
  readonly lockSeconds: number;
  readonly waitSeconds: number;
}

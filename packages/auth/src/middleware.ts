import { durationToSeconds, type Duration, type Key } from '@marmeon/core';
import { isPrefetch } from '@marmeon/http';
import { INTENDED_KEY } from '@marmeon/http/internal';
import { addVary, EXPECTS_JSON_VARY, Router, type CheckRouteName, type HttpContext, type MiddlewareClass, type Next, type RouteNameInput } from '@marmeon/router';
import { urlFor } from '@marmeon/router/url';
import { Session } from '@marmeon/session';
import { GuardContext } from './guard-context.ts';
import { authenticatedByToken, Gate } from './gate.ts';
import { markPackageUser, RequestGuard } from './request-guard.ts';
import { AccessTokenStore, tokenCan, type WithToken } from './tokens.ts';
import { UserProvider, type Authenticated } from './user.ts';

// These answers are chosen by `expectsJson`: a shared cache must not hand one variant to the other client.
const VARY = addVary(undefined, EXPECTS_JSON_VARY);

export interface AuthenticateOptions<N extends string = string> {
  /** Named route of the login page, where browsers are sent (default `auth.login`). */
  readonly loginRoute?: CheckRouteName<N>;
}

/**
 * Only for signed-in users: `Route.middleware(authenticate())` — then `ctx.user` is the user.
 * Others get 401 (JSON clients) or are sent to the login page, which brings them back afterwards
 * (`redirect().intended()`).
 *
 * `authenticate('api')` is the token guard of the stateless `api` group: `Authorization: Bearer <token>`,
 * then `ctx.user` and `ctx.token` (its abilities), and `can()` and the `Gate` ask their policies about the token's user.
 * Anything else is a 401 — a session cookie included.
 */
export function authenticate(guard: 'api'): MiddlewareClass<{}, Authenticated & WithToken>;
export function authenticate<const N extends RouteNameInput = never>(options?: AuthenticateOptions<N>): MiddlewareClass<{}, Authenticated>;
export function authenticate(options: AuthenticateOptions | 'api' = {}): MiddlewareClass<{}, Authenticated> | MiddlewareClass<{}, Authenticated & WithToken> {
  if (options === 'api') return tokenGuard();
  return authenticateFor(APP_MIDDLEWARE_GUARD, options.loginRoute ?? 'auth.login');
}

/**
 * Whose users a middleware acts for: where it gets its {@link GuardContext}, and the guard's name it stamps on the request. The
 * app's guard has a name of no package guard, `undefined` here.
 *
 * @internal
 */
export interface MiddlewareGuard {
  /** The key of the guard's context: the app's `GuardContext`, or the token of a package guard. */
  readonly context: Key;
  readonly name: string | undefined;
}

/** The app's guard. @internal */
export const APP_MIDDLEWARE_GUARD: MiddlewareGuard = { context: GuardContext, name: undefined };

/** `authenticate()` for `whose`: the class is the same, only the context it is injected with and the stamp differ. @internal */
export function authenticateFor(whose: MiddlewareGuard, loginRoute: string): MiddlewareClass<{}, Authenticated> {
  const Authenticate = class {
    /** Read by `marmeon check`: a guest never gets past. See docs/middleware.md#declaring-what-a-middleware-ensures. */
    static readonly ensures = ['authenticated'] as const;
    /** The keys it adds to the context: the router refuses a route with two middleware that add `user`. */
    static readonly adds = ['user'] as const;
    // Written out: the generated list cannot name a package guard's context.
    static readonly inject = [whose.context, Session, Router, RequestGuard] as const;

    readonly #guard: GuardContext;
    readonly #session: Session;
    readonly #router: Router;
    readonly #request: RequestGuard;

    constructor(guard: GuardContext, session: Session, router: Router, request: RequestGuard) {
      this.#guard = guard;
      this.#session = session;
      this.#router = router;
      this.#request = request;
    }

    async handle(ctx: HttpContext, next: Next<Authenticated>): Promise<Response> {
      this.#request.claim(whose.name ?? 'web', 'authenticate()');
      const user = await this.#guard.auth().user();
      if (user) {
        if (whose.name !== undefined) markPackageUser(user, whose.name);
        return next({ user });
      }
      if (ctx.expectsJson()) return Response.json({ message: 'Unauthenticated.' }, { status: 401, headers: VARY });
      // A prefetch (a hovered link) is not where the guest wanted to go — only a visit is remembered (an island's request,
      // read-only, is no visit either: it gets its `unauthorized` fallback).
      if (ctx.request.method === 'GET' && this.#session.started && !this.#session.readOnly && !isPrefetch(ctx.request)) {
        const url = new URL(ctx.request.url);
        this.#session.put(INTENDED_KEY, url.pathname + url.search);
      }
      return new Response(null, { status: 302, headers: { location: urlFor(this.#router, loginRoute), ...VARY } });
    }
  };
  Object.defineProperty(Authenticate, 'name', { value: whose.name === undefined ? 'authenticate' : `authenticate:${whose.name}` });
  return Authenticate as unknown as MiddlewareClass<{}, Authenticated>;
}

export interface GuestOptions<N extends string = string> {
  /**
   * Named route signed-in users are sent to, resolved when the request arrives (the route may be defined in a file that loads
   * later). It takes no path parameters.
   */
  readonly homeRoute: CheckRouteName<N>;
}

/**
 * Only for guests — the login and registration pages: `Route.middleware(guest('/dashboard'))` or, by the name of a route,
 * `Route.middleware(guest({ homeRoute: 'dashboard' }))`. Signed-in users are sent there instead (`/` without one).
 */
export function guest(home?: string): MiddlewareClass<{}, {}>;
export function guest<const N extends RouteNameInput>(options: GuestOptions<N>): MiddlewareClass<{}, {}>;
export function guest(home: string | GuestOptions = '/'): MiddlewareClass<{}, {}> {
  return guestFor(APP_MIDDLEWARE_GUARD, typeof home === 'string' ? home : home.homeRoute, typeof home === 'string');
}

/** `guest()` for `whose`; a package guard's names itself as the route's guard, the app's leaves the stamp alone. @internal */
export function guestFor(whose: MiddlewareGuard, home: string, isPath: boolean): MiddlewareClass<{}, {}> {
  const RedirectIfAuthenticated = class {
    static readonly inject = [whose.context, Router, RequestGuard] as const;

    readonly #guard: GuardContext;
    readonly #router: Router;
    readonly #request: RequestGuard;

    constructor(guard: GuardContext, router: Router, request: RequestGuard) {
      this.#guard = guard;
      this.#router = router;
      this.#request = request;
    }

    async handle(_ctx: HttpContext, next: Next<{}>): Promise<Response> {
      if (whose.name !== undefined) this.#request.claim(whose.name, 'guest()');
      if (!(await this.#guard.auth().check())) return next();
      const location = isPath ? home : urlFor(this.#router, home);
      return new Response(null, { status: 302, headers: { location } });
    }
  };
  Object.defineProperty(RedirectIfAuthenticated, 'name', { value: whose.name === undefined ? 'guest' : `guest:${whose.name}` });
  return RedirectIfAuthenticated as unknown as MiddlewareClass<{}, {}>;
}

export interface ConfirmedPasswordOptions<N extends string = string> {
  /** Named route of the confirmation page (default `auth.password.confirm`). */
  readonly confirmRoute?: CheckRouteName<N>;
  /** How long a confirmation counts, a {@link Duration} above zero (a number is seconds; default `AUTH_PASSWORD_TIMEOUT_SECONDS`, 15 minutes). */
  readonly maxAge?: Duration;
}

/**
 * Sensitive pages ask for the password (or a passkey) again — "sudo mode":
 * `Route.middleware(authenticate()).middleware(confirmedPassword())`. Without a recent confirmation,
 * JSON clients get 423, browsers the confirmation page (and come back afterwards).
 */
export function confirmedPassword<const N extends RouteNameInput = never>(options: ConfirmedPasswordOptions<N> = {}): MiddlewareClass<Authenticated, {}> {
  return confirmedPasswordFor(APP_MIDDLEWARE_GUARD, options.confirmRoute ?? 'auth.password.confirm', options);
}

/** `confirmedPassword()` for `whose`: the password window of the guard's own `Auth`, and A9 on a route that belongs to another guard. @internal */
export function confirmedPasswordFor(whose: MiddlewareGuard, confirmRoute: string, options: { readonly maxAge?: Duration }): MiddlewareClass<Authenticated, {}> {
  // An untyped caller passing `seconds` would silently get the default window.
  if (Object.hasOwn(options, 'seconds')) throw new TypeError('confirmedPassword(): `seconds` was renamed `maxAge`, a Duration where a number is seconds — `{ seconds: 60 }` is `{ maxAge: { minutes: 1 } }`.');
  const maxAgeSeconds = options.maxAge === undefined ? undefined : durationToSeconds(options.maxAge);
  if (maxAgeSeconds !== undefined && !(Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0)) throw new TypeError('confirmedPassword({ maxAge }) takes a Duration above zero.');
  const RequirePassword = class {
    static readonly inject = [whose.context, Session, Router, RequestGuard] as const;

    readonly #guard: GuardContext;
    readonly #session: Session;
    readonly #router: Router;
    readonly #request: RequestGuard;

    constructor(guard: GuardContext, session: Session, router: Router, request: RequestGuard) {
      this.#guard = guard;
      this.#session = session;
      this.#router = router;
      this.#request = request;
    }

    async handle(ctx: HttpContext<Authenticated>, next: Next<{}>): Promise<Response> {
      // The window is the guard's own: one that the other guard opened is no confirmation here.
      if (whose.name === undefined) this.#request.requireApp('confirmedPassword()');
      else this.#request.requireGuard(whose.name, 'confirmedPassword()');
      if (this.#guard.auth().passwordRecentlyConfirmed(maxAgeSeconds)) return next();
      if (ctx.expectsJson()) return Response.json({ message: 'Password confirmation required.' }, { status: 423, headers: VARY });
      if (ctx.request.method === 'GET' && !this.#session.readOnly && !isPrefetch(ctx.request)) {
        const url = new URL(ctx.request.url);
        this.#session.put(INTENDED_KEY, url.pathname + url.search);
      }
      return new Response(null, { status: 302, headers: { location: urlFor(this.#router, confirmRoute), ...VARY } });
    }
  };
  Object.defineProperty(RequirePassword, 'name', { value: whose.name === undefined ? 'confirmedPassword' : `confirmedPassword:${whose.name}` });
  return RequirePassword as unknown as MiddlewareClass<Authenticated, {}>;
}

function tokenGuard(): MiddlewareClass<{}, Authenticated & WithToken> {
  const AuthenticateToken = class {
    static readonly ensures = ['authenticated'] as const;
    static readonly adds = ['user', 'token'] as const;

    readonly #tokens: AccessTokenStore;
    readonly #users: UserProvider;
    readonly #gate: Gate;
    readonly #request: RequestGuard;

    constructor(tokens: AccessTokenStore, users: UserProvider, gate: Gate, request: RequestGuard) {
      this.#tokens = tokens;
      this.#users = users;
      this.#gate = gate;
      this.#request = request;
    }

    async handle(ctx: HttpContext, next: Next<Authenticated & WithToken>): Promise<Response> {
      this.#request.claim('api', "authenticate('api')");
      const header = ctx.request.headers.get('authorization') ?? '';
      const presented = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
      const token = presented === undefined ? undefined : await this.#tokens.find(presented);
      const found = token && (await this.#users.findById(token.userId as never));
      if (!token || !found) {
        return Response.json({ message: 'Unauthenticated.' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
      }
      await this.#tokens.touch(token);
      // The policies of this request see the token's user — the api group has no session to ask (`abilities()` still checks the token).
      authenticatedByToken(this.#gate, found.user);
      return next({ user: found.user, token });
    }
  };
  Object.defineProperty(AuthenticateToken, 'name', { value: 'authenticate:api' });
  return AuthenticateToken;
}

/**
 * The token must grant every ability: `Route.middleware(authenticate('api'), …)` then
 * `.middleware(abilities('users:read'))` — 403 otherwise. Names at least one ability. Only after the token guard.
 */
export function abilities(first: string, ...more: string[]): MiddlewareClass<WithToken, {}> {
  const required = [first, ...more];
  // Fail closed: without a name nothing would be checked and every token would pass.
  if (required.some((ability) => typeof ability !== 'string' || ability === '')) {
    throw new TypeError('abilities(): name at least one ability; a route every token may call needs no abilities().');
  }
  const CheckAbilities = class {
    handle(ctx: HttpContext<WithToken>, next: Next<{}>): Promise<Response> | Response {
      const missing = required.filter((ability) => !tokenCan(ctx.token, ability));
      return missing.length === 0 ? next() : Response.json({ message: `This token may not: ${missing.join(', ')}.` }, { status: 403 });
    }
  };
  Object.defineProperty(CheckAbilities, 'name', { value: `abilities:${required.join(',')}` });
  return CheckAbilities;
}

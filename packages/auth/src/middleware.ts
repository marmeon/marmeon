import { INTENDED_KEY, isPrefetch } from '@marmeon/http';
import { addVary, EXPECTS_JSON_VARY, Router, urlFor, type CheckRouteName, type HttpContext, type MiddlewareClass, type Next, type RouteNameInput } from '@marmeon/router';
import { Session } from '@marmeon/session';
import { Auth } from './auth.ts';
import { authenticatedByToken, Gate } from './gate.ts';
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
  const loginRoute: string = options.loginRoute ?? 'auth.login';
  const Authenticate = class {
    readonly #auth: Auth;
    readonly #session: Session;
    readonly #router: Router;

    constructor(auth: Auth, session: Session, router: Router) {
      this.#auth = auth;
      this.#session = session;
      this.#router = router;
    }

    async handle(ctx: HttpContext, next: Next<Authenticated>): Promise<Response> {
      const user = await this.#auth.user();
      if (user) return next({ user });
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
  Object.defineProperty(Authenticate, 'name', { value: 'authenticate' });
  return Authenticate;
}

/**
 * Only for guests — the login and registration pages: `Route.middleware(guest('/dashboard'))`.
 * Signed-in users are sent to `home` instead.
 */
export function guest(home = '/'): MiddlewareClass<{}, {}> {
  const RedirectIfAuthenticated = class {
    readonly #auth: Auth;

    constructor(auth: Auth) {
      this.#auth = auth;
    }

    async handle(_ctx: HttpContext, next: Next<{}>): Promise<Response> {
      return (await this.#auth.check()) ? new Response(null, { status: 302, headers: { location: home } }) : next();
    }
  };
  Object.defineProperty(RedirectIfAuthenticated, 'name', { value: 'guest' });
  return RedirectIfAuthenticated;
}

export interface ConfirmedPasswordOptions<N extends string = string> {
  /** Named route of the confirmation page (default `auth.password.confirm`). */
  readonly confirmRoute?: CheckRouteName<N>;
  /** How long a confirmation counts, in seconds (default `AUTH_PASSWORD_TIMEOUT`, 15 minutes). */
  readonly seconds?: number;
}

/**
 * Sensitive pages ask for the password again — "sudo mode":
 * `Route.middleware(authenticate()).middleware(confirmedPassword())`. Without a recent confirmation,
 * JSON clients get 423, browsers the confirmation page (and come back afterwards).
 */
export function confirmedPassword<const N extends RouteNameInput = never>(options: ConfirmedPasswordOptions<N> = {}): MiddlewareClass<Authenticated, {}> {
  const confirmRoute: string = options.confirmRoute ?? 'auth.password.confirm';
  const RequirePassword = class {
    readonly #auth: Auth;
    readonly #session: Session;
    readonly #router: Router;

    constructor(auth: Auth, session: Session, router: Router) {
      this.#auth = auth;
      this.#session = session;
      this.#router = router;
    }

    async handle(ctx: HttpContext<Authenticated>, next: Next<{}>): Promise<Response> {
      if (this.#auth.passwordRecentlyConfirmed(options.seconds)) return next();
      if (ctx.expectsJson()) return Response.json({ message: 'Password confirmation required.' }, { status: 423, headers: VARY });
      if (ctx.request.method === 'GET' && !this.#session.readOnly && !isPrefetch(ctx.request)) {
        const url = new URL(ctx.request.url);
        this.#session.put(INTENDED_KEY, url.pathname + url.search);
      }
      return new Response(null, { status: 302, headers: { location: urlFor(this.#router, confirmRoute), ...VARY } });
    }
  };
  Object.defineProperty(RequirePassword, 'name', { value: 'confirmedPassword' });
  return RequirePassword;
}

function tokenGuard(): MiddlewareClass<{}, Authenticated & WithToken> {
  const AuthenticateToken = class {
    readonly #tokens: AccessTokenStore;
    readonly #users: UserProvider;
    readonly #gate: Gate;

    constructor(tokens: AccessTokenStore, users: UserProvider, gate: Gate) {
      this.#tokens = tokens;
      this.#users = users;
      this.#gate = gate;
    }

    async handle(ctx: HttpContext, next: Next<Authenticated & WithToken>): Promise<Response> {
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
 * `.middleware(abilities('users:read'))` — 403 otherwise. Only after the token guard.
 */
export function abilities(...required: string[]): MiddlewareClass<WithToken, {}> {
  const CheckAbilities = class {
    handle(ctx: HttpContext<WithToken>, next: Next<{}>): Promise<Response> | Response {
      const missing = required.filter((ability) => !tokenCan(ctx.token, ability));
      return missing.length === 0 ? next() : Response.json({ message: `This token may not: ${missing.join(', ')}.` }, { status: 403 });
    }
  };
  Object.defineProperty(CheckAbilities, 'name', { value: `abilities:${required.join(',')}` });
  return CheckAbilities;
}

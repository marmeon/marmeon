import { INTENDED_KEY } from '@bespokecore/http';
import { Router, type HttpContext, type MiddlewareClass, type Next } from '@bespokecore/router';
import { Session } from '@bespokecore/session';
import { Auth } from './auth.ts';
import type { Authenticated } from './user.ts';

export interface AuthenticateOptions {
  /** Named route of the login page, where browsers are sent (default `auth.login`). */
  readonly loginRoute?: string;
}

/**
 * Only for signed-in users: `Route.middleware(authenticate())` — then `ctx.user` is the user.
 * Others get 401 (JSON clients) or are sent to the login page, which brings them back afterwards
 * (`redirect().intended()`).
 */
export function authenticate(options: AuthenticateOptions = {}): MiddlewareClass<{}, Authenticated> {
  const loginRoute = options.loginRoute ?? 'auth.login';
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
      if (ctx.expectsJson()) return Response.json({ message: 'Unauthenticated.' }, { status: 401 });
      if (ctx.request.method === 'GET' && this.#session.started) {
        const url = new URL(ctx.request.url);
        this.#session.put(INTENDED_KEY, url.pathname + url.search);
      }
      return new Response(null, { status: 302, headers: { location: this.#router.url(loginRoute) } });
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

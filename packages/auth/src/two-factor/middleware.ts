import { durationToSeconds, type Duration } from '@marmeon/core';
import { isPrefetch } from '@marmeon/http';
import { INTENDED_KEY } from '@marmeon/http/internal';
import { addVary, EXPECTS_JSON_VARY, HttpError, Router, type CheckRouteName, type HttpContext, type MiddlewareClass, type Next, type RouteNameInput } from '@marmeon/router';
import { urlFor } from '@marmeon/router/url';
import { Session } from '@marmeon/session';
import { GuardContext } from '../guard-context.ts';
import { APP_MIDDLEWARE_GUARD, type MiddlewareGuard } from '../middleware.ts';
import { RequestGuard } from '../request-guard.ts';
import { idOf, type Authenticated } from '../user.ts';
import { secondFactorProvenWithin } from './proof.ts';

const VARY = addVary(undefined, EXPECTS_JSON_VARY);

/** How long a proven second factor counts when `twoFactor()` gets no `maxAge`. */
const DEFAULT_MAX_AGE: Duration = { hours: 24 };

export interface TwoFactorMiddlewareOptions<S extends string = string, V extends string = string, L extends string = string> {
  /** Named route of the page where a user without a second factor sets one up. */
  readonly setup: CheckRouteName<S>;
  /** Named route of the page that asks this session for its second factor (a form calling `TwoFactor.stepUp()`). */
  readonly verify: CheckRouteName<V>;
  /** How long a proven second factor counts, a {@link Duration} above zero (a number is seconds); after that the session is asked again. Default: 24 hours. */
  readonly maxAge?: Duration;
  /** Named route of the login page for a request without a user (default `auth.login`) — put `authenticate()` before this middleware, which makes it unreachable. */
  readonly loginRoute?: CheckRouteName<L>;
}

/**
 * Opens a route group only to sessions that have proven a second factor: `Route.middleware(authenticate()).middleware(twoFactor({ setup, verify }))`.
 * A user without a factor is sent to `setup`, one whose session has not proven it (a session from before the factor, or older
 * than `maxAge`, 24 hours by default) to `verify`; both come back afterwards. JSON clients get 403 with `{ error: 'two_factor_required' }` or
 * `{ error: 'two_factor_unverified' }`. Nobody passes by default: whatever is unclear is refused.
 *
 * Provided, never installed: nothing in the framework or in a new app adds it to a route. It reads the session, so it belongs
 * to the `web` group; the stateless `api` group has no session and answers 401. See `docs/two-factor-authentication.md#requiring-it`.
 */
export function twoFactor<const S extends RouteNameInput = never, const V extends RouteNameInput = never, const L extends RouteNameInput = never>(
  options: TwoFactorMiddlewareOptions<S, V, L>,
): MiddlewareClass<Authenticated, {}> {
  return twoFactorFor(APP_MIDDLEWARE_GUARD, options.loginRoute ?? 'auth.login', options);
}

/** `twoFactor()` for `whose`: the guard's own proof and factors, and A9 on a route that belongs to another guard. @internal */
export function twoFactorFor(whose: MiddlewareGuard, loginRoute: string | undefined, options: { readonly setup: string; readonly verify: string; readonly maxAge?: Duration }): MiddlewareClass<Authenticated, {}> {
  const maxAgeSeconds = durationToSeconds(options.maxAge ?? DEFAULT_MAX_AGE);
  if (!(Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0)) throw new Error('twoFactor({ maxAge }) takes a Duration above zero.');
  const RequireTwoFactor = class {
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

    async handle(ctx: HttpContext<Authenticated>, next: Next<{}>): Promise<Response> {
      // The proof is the guard's own: on a route of another guard it proves nothing about this guard's user.
      if (whose.name === undefined) this.#request.requireApp('twoFactor()');
      else this.#request.requireGuard(whose.name, 'twoFactor()');
      // Asked of the session itself, not of `ctx.user`: a pending sign-in, a token or a missing `authenticate()` are all "nobody" here.
      const user = await this.#guard.auth().user();
      if (!user) {
        if (ctx.expectsJson()) return Response.json({ message: 'Unauthenticated.' }, { status: 401, headers: VARY });
        // Past `requireGuard` only a middleware in between can have ended the sign-in. A package guard's middleware gets no login page
        // of its own and must never fall back to the app's `auth.login`: a browser gets the 401 page.
        if (loginRoute === undefined) throw new HttpError(401, undefined, VARY);
        return this.#redirect(ctx, loginRoute);
      }
      if ((await this.#guard.factors().factors(idOf(user))).length === 0) return this.#refuse(ctx, 'two_factor_required', options.setup);
      if (!secondFactorProvenWithin(this.#session, maxAgeSeconds, Math.floor(this.#guard.clock().now() / 1000), this.#guard.names)) return this.#refuse(ctx, 'two_factor_unverified', options.verify);
      return next();
    }

    #refuse(ctx: HttpContext<Authenticated>, error: 'two_factor_required' | 'two_factor_unverified', route: string): Response {
      if (ctx.expectsJson()) return Response.json({ error }, { status: 403, headers: VARY });
      return this.#redirect(ctx, route);
    }

    #redirect(ctx: HttpContext<Authenticated>, route: string): Response {
      // Only a visit is remembered, to come back to after the factor: not a prefetch, not a form post, not a read-only island request.
      if (ctx.request.method === 'GET' && this.#session.started && !this.#session.readOnly && !isPrefetch(ctx.request)) {
        const url = new URL(ctx.request.url);
        this.#session.put(INTENDED_KEY, url.pathname + url.search);
      }
      return new Response(null, { status: 302, headers: { location: urlFor(this.#router, route), ...VARY } });
    }
  };
  Object.defineProperty(RequireTwoFactor, 'name', { value: whose.name === undefined ? 'twoFactor' : `twoFactor:${whose.name}` });
  return RequireTwoFactor;
}

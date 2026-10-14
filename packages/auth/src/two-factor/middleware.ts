import { INTENDED_KEY, isPrefetch } from '@marmeon/http';
import { addVary, EXPECTS_JSON_VARY, Router, urlFor, type CheckRouteName, type HttpContext, type MiddlewareClass, type Next, type RouteNameInput } from '@marmeon/router';
import { Session } from '@marmeon/session';
import { Auth, AUTH_SESSION_KEYS } from '../auth.ts';
import { idOf, type Authenticated } from '../user.ts';
import { TwoFactorState } from './state.ts';

const VARY = addVary(undefined, EXPECTS_JSON_VARY);

/** How long a proven second factor counts when `twoFactor()` gets no `maxAge`, in seconds (24 hours). */
export const TWO_FACTOR_MAX_AGE = 86_400;

export interface TwoFactorMiddlewareOptions<S extends string = string, V extends string = string, L extends string = string> {
  /** Named route of the page where a user without a second factor sets one up. */
  readonly setup: CheckRouteName<S>;
  /** Named route of the page that asks this session for its second factor (a form calling `TwoFactor.stepUp()`). */
  readonly verify: CheckRouteName<V>;
  /** How long a proven second factor counts, in seconds; after that the session is asked again. Default: 24 hours (`TWO_FACTOR_MAX_AGE`). */
  readonly maxAge?: number;
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
  const { maxAge } = options;
  if (maxAge !== undefined && !(Number.isFinite(maxAge) && maxAge > 0)) throw new Error('twoFactor({ maxAge }) takes a number of seconds above zero.');
  const loginRoute: string = options.loginRoute ?? 'auth.login';
  const RequireTwoFactor = class {
    readonly #auth: Auth;
    readonly #session: Session;
    readonly #router: Router;
    readonly #state: TwoFactorState;

    constructor(auth: Auth, session: Session, router: Router, state: TwoFactorState) {
      this.#auth = auth;
      this.#session = session;
      this.#router = router;
      this.#state = state;
    }

    async handle(ctx: HttpContext<Authenticated>, next: Next<{}>): Promise<Response> {
      // Asked of the session itself, not of `ctx.user`: a pending sign-in, a token or a missing `authenticate()` are all "nobody" here.
      const user = await this.#auth.user();
      if (!user) {
        if (ctx.expectsJson()) return Response.json({ message: 'Unauthenticated.' }, { status: 401, headers: VARY });
        return this.#redirect(ctx, loginRoute);
      }
      if ((await this.#state.factors(idOf(user))).length === 0) return this.#refuse(ctx, 'two_factor_required', options.setup);
      if (!this.#proven()) return this.#refuse(ctx, 'two_factor_unverified', options.verify);
      return next();
    }

    /** Whether this session proved a second factor, and recently enough. A missing, malformed or future time counts as not proven. */
    #proven(): boolean {
      const at = this.#session.started ? this.#session.get(AUTH_SESSION_KEYS.twoFactorAt) : undefined;
      if (typeof at !== 'number' || !Number.isFinite(at)) return false;
      const age = Math.floor(Date.now() / 1000) - at;
      return age >= 0 && age <= (maxAge ?? TWO_FACTOR_MAX_AGE);
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
  Object.defineProperty(RequireTwoFactor, 'name', { value: 'twoFactor' });
  return RequireTwoFactor;
}

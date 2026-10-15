import { Clock } from '@marmeon/core';
import { INTENDED_KEY, isPrefetch } from '@marmeon/http';
import { addVary, EXPECTS_JSON_VARY, Router, urlFor, type CheckRouteName, type HttpContext, type MiddlewareClass, type Next, type RouteNameInput } from '@marmeon/router';
import { Session } from '@marmeon/session';
import { Auth } from '../auth.ts';
import { idOf, type Authenticated } from '../user.ts';
import { FACTOR_CHANGE_MAX_AGE, secondFactorProvenWithin } from './proof.ts';
import { TwoFactorState } from './state.ts';

const VARY = addVary(undefined, EXPECTS_JSON_VARY);

export interface ConfirmedSecondFactorOptions<V extends string = string> {
  /** Named route of the page that asks this session for its second factor (a form calling `TwoFactor.stepUp()`). */
  readonly verify: CheckRouteName<V>;
}

/**
 * Opens a route only to a session that proved its second factor within the last fifteen minutes, where the account has one: put it
 * in front of every route that changes the account's factors, beside `confirmedPassword()`. An account without a factor passes —
 * its first factor needs only the password — so the setup page stays reachable; use `twoFactor()` to require a factor. A stale session is sent to
 * `verify` and comes back afterwards; JSON clients get 403 with `{ error: 'two_factor_unverified' }`.
 *
 * The methods that change factors refuse the same sessions by themselves; this middleware makes the route say so instead of
 * answering 500. See `docs/two-factor-authentication.md#changing-the-factors`.
 */
export function confirmedSecondFactor<const V extends RouteNameInput = never>(options: ConfirmedSecondFactorOptions<V>): MiddlewareClass<Authenticated, {}> {
  const Confirmed = class {
    readonly #auth: Auth;
    readonly #session: Session;
    readonly #router: Router;
    readonly #state: TwoFactorState;
    readonly #clock: Clock;

    constructor(auth: Auth, session: Session, router: Router, state: TwoFactorState, clock: Clock) {
      this.#auth = auth;
      this.#session = session;
      this.#router = router;
      this.#state = state;
      this.#clock = clock;
    }

    async handle(ctx: HttpContext<Authenticated>, next: Next<{}>): Promise<Response> {
      // Asked of the session itself, not of `ctx.user`: a pending sign-in, a token or a missing `authenticate()` are all "nobody" here.
      const user = await this.#auth.user();
      if (!user) {
        if (ctx.expectsJson()) return Response.json({ message: 'Unauthenticated.' }, { status: 401, headers: VARY });
        return this.#redirect(ctx, 'auth.login');
      }
      if ((await this.#state.factors(idOf(user))).length === 0) return next();
      if (secondFactorProvenWithin(this.#session, FACTOR_CHANGE_MAX_AGE, Math.floor(this.#clock.now() / 1000))) return next();
      if (ctx.expectsJson()) return Response.json({ error: 'two_factor_unverified' }, { status: 403, headers: VARY });
      return this.#redirect(ctx, options.verify);
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
  Object.defineProperty(Confirmed, 'name', { value: 'confirmedSecondFactor' });
  return Confirmed;
}

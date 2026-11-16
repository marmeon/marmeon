import { withCode } from '@marmeon/core/internal';

/** The names an app guard stamps: the session guard and the token guard of the app. A package guard can have neither name. */
const APP_STAMPS: readonly string[] = ['web', 'api'];

export const isApp = (stamp: string): boolean => APP_STAMPS.includes(stamp);

/** The same guard, or the app's session and token guard, which are one circle of users. */
export const compatible = (a: string, b: string): boolean => a === b || (isApp(a) && isApp(b));

/** Set while `makeRequestGuard()` builds one: the constructor refuses every other caller, the container's own autowiring included. */
let making = false;

export const refuse = (message: string): never => {
  throw new Error(withCode('A9', message));
};

/**
 * The guard a request's route acts for, set by the first middleware that signs a user in or checks one (`authenticate()` stamps
 * `web`, `authenticate('api')` `api`, a package guard's `authenticate()` its own name) and read by every middleware and the `Gate`
 * after it. Whoever reads it decides on the stamp, so a sudo window or a policy of one guard never opens a route of another; a package guard's
 * confirmation also asks whether its own `authenticate()` has run, as the router sets the stamp before any middleware does.
 *
 * @internal
 */
export class RequestGuard {
  #name: string | undefined;
  /** The guard whose `authenticate()` has actually run on this request: the stamp is known before it, so it cannot say. */
  #authenticated: string | undefined;
  /** The guards whose policies decided on this request while the route had no stamp. */
  readonly #judged = new Set<string>();

  // The container builds a class nobody bound, on its own and for every caller: a gate and a middleware would each get an empty stamp and
  // every check would open. So only `bindRequestGuard()` can make one, and an unbound `RequestGuard` fails where it is asked for.
  constructor() {
    if (!making) throw new TypeError('RequestGuard is made by the container binding of the auth package only: register AuthServiceProvider (or a package guard) to bind it.');
  }

  /** The guard of the route, or `undefined` while no middleware has named one. */
  get name(): string | undefined {
    return this.#name;
  }

  /**
   * A middleware of `guard` that signs in or checks a user names it as the route's guard. Two package guards, or a package guard and the
   * app's, on one route are error A9; the app's two guards (`web`, `api`) may follow each other. So is a guard that a policy has already
   * judged for on this route (see {@link RequestGuard.admit}): the controller must not act for a user other than the one the policy saw.
   */
  claim(guard: string, by: string): void {
    const current = this.#name;
    if (current !== undefined && !compatible(current, guard)) {
      refuse(`${by} acts for the guard '${guard}', but an earlier middleware of this route acts for '${current}': a route belongs to one guard.`);
    }
    for (const judged of this.#judged) {
      if (!compatible(judged, guard)) refuse(`${by} acts for the guard '${guard}', but a policy of '${judged}' decided on this request before it: a route belongs to one guard.`);
    }
    this.#name = guard;
  }

  /** The guard the router found in the route's middleware list, before its first middleware runs: {@link RequestGuard.claim} by the route itself. */
  stamp(guard: string): void {
    this.claim(guard, 'The middleware of this route');
  }

  /** The app's middleware: A9 on a route that belongs to a package guard; on a route with no guard yet it takes the app's, so a later package middleware cannot mix in. */
  requireApp(by: string): void {
    const current = this.#name;
    if (current !== undefined && !isApp(current)) {
      refuse(`${by} asks the app's guard, but this route belongs to the guard '${current}': use the middleware of '${current}' (its sign-in, password confirmation and second factor are not the app's).`);
    }
    for (const judged of this.#judged) {
      if (!isApp(judged)) refuse(`${by} asks the app's guard, but a policy of '${judged}' decided on this request before it: a route belongs to one guard.`);
    }
    this.#name ??= 'web';
  }

  /**
   * Whether the route is `guard`'s: the app's guard also owns a route no middleware named (nothing is claimed), a package guard only its own.
   * Reads the stamp, never sets it.
   */
  servesGuard(guard: string): boolean {
    const current = this.#name;
    return isApp(guard) ? current === undefined || isApp(current) : current === guard;
  }

  /**
   * Whether a policy of `policyGuard` may decide on this request. On a route with a stamp only a policy of that guard may (`web` and
   * `api` count as one); another one gets no, never yes. On a route without a stamp every policy may, and the guard is noted: a middleware
   * that names an incompatible guard afterwards is A9 ({@link RequestGuard.claim}).
   */
  admit(policyGuard: string): boolean {
    const current = this.#name;
    if (current !== undefined) return compatible(current, policyGuard);
    this.#judged.add(policyGuard);
    return true;
  }

  /** `guard`'s `authenticate()` runs now: what {@link RequestGuard.requireGuard} asks for. */
  authenticated(guard: string): void {
    this.#authenticated = guard;
  }

  /** A package guard's middleware that needs a user already checked: A9 unless that guard's own `authenticate()` has run before it: the stamp alone is set ahead of every middleware. */
  requireGuard(guard: string, by: string): void {
    const current = this.#name;
    if (current === guard && this.#authenticated === guard) return;
    if (current === guard) refuse(`${by} of the guard '${guard}' needs the guard's authenticate() before it: it has not run on this request yet.`);
    if (current === undefined) refuse(`${by} of the guard '${guard}' needs the guard's authenticate() before it: this route belongs to no guard yet.`);
    refuse(`${by} acts for the guard '${guard}', but this route belongs to '${current}': a route belongs to one guard.`);
  }
}

export function makeRequestGuard(): RequestGuard {
  making = true;
  try {
    return new RequestGuard();
  } finally {
    making = false;
  }
}


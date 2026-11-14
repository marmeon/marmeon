import type { Container, Resolver } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';

/** The names an app guard stamps: the session guard and the token guard of the app. A package guard can have neither name. */
const APP_STAMPS: readonly string[] = ['web', 'api'];

const isApp = (stamp: string): boolean => APP_STAMPS.includes(stamp);

/** Set while `makeRequestGuard()` builds one: the constructor refuses every other caller, the container's own autowiring included. */
let making = false;

const refuse = (message: string): never => {
  throw new Error(withCode('A9', message));
};

/**
 * The guard a request's route acts for, set by the first middleware that signs a user in or checks one (`authenticate()` stamps
 * `web`, `authenticate('api')` `api`, a package guard's `authenticate()` its own name) and read by every middleware and the `Gate`
 * after it. Whoever reads it decides on the stamp alone, so a sudo window or a policy of one guard never opens a route of another.
 *
 * @internal
 */
export class RequestGuard {
  #name: string | undefined;

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
   * app's, on one route are error A9; the app's two guards (`web`, `api`) may follow each other.
   */
  claim(guard: string, by: string): void {
    const current = this.#name;
    if (current !== undefined && current !== guard && !(isApp(current) && isApp(guard))) {
      refuse(`${by} acts for the guard '${guard}', but an earlier middleware of this route acts for '${current}': a route belongs to one guard.`);
    }
    this.#name = guard;
  }

  /** The app guard's middleware: A9 on a route that belongs to a package guard; on a route with no guard yet it takes the app's, so a later package middleware cannot mix in. */
  requireApp(by: string): void {
    const current = this.#name;
    if (current !== undefined && !isApp(current)) {
      refuse(`${by} asks the app's guard, but this route belongs to the guard '${current}': use the middleware of '${current}' (its sign-in, password confirmation and second factor are not the app's).`);
    }
    this.#name ??= 'web';
  }

  /**
   * `decide` is for a gate that asks a policy now; a projection that is only made, to be computed when a page renders, just checks.
   * The `Gate` on a route of a package guard: A9 for now, whatever the policy. The gate asks the app's `Auth`, which is not who the
   * route's controller acts for; refusing is the fail-closed answer until a policy names the guard whose users it judges.
   */
  refuseGate(method: string, decide = false): void {
    const current = this.#name;
    // A policy that runs now has judged the app's user: the route is the app's from here, so a package guard's `authenticate()` after it
    // is A9 and cannot make a controller act for another user than the one the policy saw.
    if (decide && current === undefined) this.#name = 'web';
    if (current !== undefined && !isApp(current)) {
      refuse(`Gate.${method}() asks the policies about the app's users, but this route belongs to the guard '${current}': a policy cannot judge the users of a package guard yet; authorize on ctx.user (describeAccess) instead.`);
    }
  }

  /** A package guard's middleware that needs a user already checked: A9 unless that guard's own `authenticate()` came first. */
  requireGuard(guard: string, by: string): void {
    const current = this.#name;
    if (current === guard) return;
    if (current === undefined) refuse(`${by} of the guard '${guard}' needs the guard's authenticate() before it: this route belongs to no guard yet.`);
    refuse(`${by} acts for the guard '${guard}', but this route belongs to '${current}': a route belongs to one guard.`);
  }
}

/** Binds {@link RequestGuard} per request, once: whichever provider needs it first. @internal */
export function bindRequestGuard(container: Container): void {
  if (!container.has(RequestGuard)) container.scoped(RequestGuard, makeRequestGuard);
}

/** The guard of the route `scope` serves: `web`, `api`, a package guard's name, or `undefined` before any middleware named one. @internal */
export function requestGuard(scope: Resolver): string | undefined {
  return scope.make(RequestGuard).name;
}

/** The users a package guard's `authenticate()` handed to the route, by guard: the object itself tells whose user it is. */
const PACKAGE_USERS = new WeakMap<object, string>();

/** Notes that `user` is a user of the package guard `guard`. @internal */
export function markPackageUser(user: unknown, guard: string): void {
  if (typeof user === 'object' && user !== null) PACKAGE_USERS.set(user, guard);
}

/**
 * The app's middleware that reads `ctx.user`, even when it was built by hand and has no stamp to read: A9 for a user a package guard
 * signed in. @internal
 */
export function refusePackageUser(user: unknown, by: string): void {
  const guard = typeof user === 'object' && user !== null ? PACKAGE_USERS.get(user) : undefined;
  if (guard !== undefined) refuse(`${by} asks the app's guard, but ctx.user is a user of the guard '${guard}': use the middleware of '${guard}'.`);
}

function makeRequestGuard(): RequestGuard {
  making = true;
  try {
    return new RequestGuard();
  } finally {
    making = false;
  }
}

/** A `RequestGuard` for a test that builds a middleware or a gate by hand. @internal */
export function newRequestGuard(): RequestGuard {
  return makeRequestGuard();
}

/** `resolve` that also hands out a fresh `RequestGuard`, for a test that builds a `Gate` with a resolver of its own. @internal */
export function withRequestGuard<R extends (Class: never) => unknown>(resolve: R): R {
  return ((Class: unknown) => (Class === RequestGuard ? newRequestGuard() : (resolve as unknown as (c: unknown) => unknown)(Class))) as unknown as R;
}

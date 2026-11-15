import type { Container, Resolver } from '@marmeon/core';
import type { ClassResolver, Router } from '@marmeon/router';
import { withCode } from '@marmeon/core/internal';
import { slotProblem, slotsSealed } from './guard-slot.ts';
import { GuardSlotError } from './slot-bindings.ts';

/** The names an app guard stamps: the session guard and the token guard of the app. A package guard can have neither name. */
const APP_STAMPS: readonly string[] = ['web', 'api'];

const isApp = (stamp: string): boolean => APP_STAMPS.includes(stamp);

/** The same guard, or the app's session and token guard, which are one circle of users. */
const compatible = (a: string, b: string): boolean => a === b || (isApp(a) && isApp(b));

/** Set while `makeRequestGuard()` builds one: the constructor refuses every other caller, the container's own autowiring included. */
let making = false;

const refuse = (message: string): never => {
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

/** Binds {@link RequestGuard} per request, once: whichever provider needs it first. @internal */
export function bindRequestGuard(container: Container): void {
  if (!container.has(RequestGuard)) container.scoped(RequestGuard, makeRequestGuard);
}

/** The guard of the route `scope` serves: `web`, `api`, a package guard's name, or `undefined` before any middleware named one. @internal */
export function requestGuard(scope: Resolver): string | undefined {
  return scope.make(RequestGuard).name;
}

/** The middleware classes that name the guard of the route they stand on, by class identity: the one thing the router's start hook goes by. */
const NAMING = new WeakMap<object, (resolve: ClassResolver) => string>();

/**
 * Marks `Class`, a middleware class made by a guard's factory, as naming the route's guard: `authenticate()`, `authenticate('api')`
 * and a package guard's `authenticate()` and `guest()`. `guard` is read when a route is judged, not now (a slot is bound only at boot),
 * with the resolver of the container that judges it; it throws for a guard it cannot name, and then nothing is remembered.
 * Recognition is by the class itself, never by its name or shape. @internal
 */
export function markNamingMiddleware(Class: object, guard: (resolve: ClassResolver) => string): void {
  NAMING.set(Class, guard);
}

/** What the middleware list of a route says about its guard: the one it names, or two that cannot share a route. */
export type RouteGuard = { readonly guard: string } | { readonly conflict: string };

/** Whether the guard `middleware` names can be told now: a middleware that names none, or a slot that is bound. */
function knows(middleware: object, resolve: ClassResolver): boolean {
  const named = NAMING.get(middleware);
  if (named === undefined) return true;
  try {
    named(resolve);
    return true;
  } catch (error) {
    if (error instanceof GuardSlotError) return false;
    throw error;
  }
}

const ROUTE_GUARDS = new WeakMap<readonly object[], RouteGuard | undefined>();

/** What stands in for a resolver where none is given: a middleware that needs one to name its guard cannot be judged, so it fails. */
const NO_RESOLVER: ClassResolver = () => {
  throw new TypeError('No container to resolve a guard slot with.');
};

/**
 * The guard a route's middleware list names, or `undefined` when no middleware in it does. The first naming middleware sets it; another
 * that names an incompatible guard (anything but equal, or `web` with `api`) makes it a `conflict` whose text names both. The router hands
 * the same frozen list for every request of a route, so the answer is worked out once per list: only an answer, never a failure, so a
 * slot that is not bound yet is asked again.
 * @internal
 */
export function routeGuardOf(pipeline: readonly object[], resolve: ClassResolver = NO_RESOLVER): RouteGuard | undefined {
  if (ROUTE_GUARDS.has(pipeline)) return ROUTE_GUARDS.get(pipeline);
  let found: { guard: string; by: string } | undefined;
  let result: RouteGuard | undefined;
  for (const middleware of pipeline) {
    const named = NAMING.get(middleware);
    if (named === undefined) continue;
    const guard = named(resolve);
    const by = (middleware as { name?: unknown }).name;
    const label = typeof by === 'string' && by !== '' ? by : 'a middleware';
    if (found === undefined) found = { guard, by: label };
    else if (!compatible(found.guard, guard)) {
      result = { conflict: `${found.by} acts for the guard '${found.guard}' and ${label} for '${guard}': a route belongs to one guard.` };
      break;
    }
  }
  result ??= found === undefined ? undefined : { guard: found.guard };
  ROUTE_GUARDS.set(pipeline, result);
  return result;
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

const WIRED = new WeakSet<Router>();

/**
 * Makes the router stamp the guard of a route before its first middleware runs (a middleware list that names two guards fails the
 * request with A9), and lets the kernel and `marmeon check` refuse such a route at start. A route that uses a guard slot nobody bound
 * is error A8 there. `start` resolves what the start check reads (a slot's binding). Once per router, whichever provider step calls first. @internal
 */
export function stampRoutes(router: Router, start: ClassResolver = NO_RESOLVER): void {
  if (WIRED.has(router)) return;
  WIRED.add(router);
  router.beforeMiddleware((_route, pipeline, resolve) => {
    const found = routeGuardOf(pipeline, resolve);
    if (found === undefined) return;
    if ('conflict' in found) return refuse(found.conflict);
    resolve(RequestGuard).stamp(found.guard);
  });
  router.checkPipelines((_route, pipeline) => {
    let found: RouteGuard | undefined;
    try {
      found = routeGuardOf(pipeline, start);
    } catch (error) {
      if (!(error instanceof GuardSlotError)) throw error;
      // Exact: a route uses a slot that has no guard. `marmeon check` registers the app and never boots it, so a slot a provider binds
      // at boot is unbound there: only the start, after the boot, may say so. Until then the rest of the list is still judged.
      if (slotsSealed(start)) return { message: error.detail, code: 'A8', docs: 'docs/errors.md#server-error-codes' };
      found = routeGuardOf(pipeline.filter((middleware) => knows(middleware, start)), start);
    }
    const refused = slotProblem(pipeline, start);
    if (refused !== undefined) return { message: refused, code: 'A8', docs: 'docs/errors.md#server-error-codes' };
    return found !== undefined && 'conflict' in found ? { message: found.conflict, code: 'A9', docs: 'docs/errors.md#server-error-codes' } : undefined;
  });
}

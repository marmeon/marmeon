import type { Container, Resolver } from '@marmeon/core';
import type { ClassResolver, Router } from '@marmeon/router';
import { slotProblem, slotsSealed } from './guard-slot.ts';
import { GuardSlotError } from './slot-bindings.ts';
import { compatible, makeRequestGuard, refuse, RequestGuard } from './guard-stamp.ts';

export { RequestGuard } from './guard-stamp.ts';

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

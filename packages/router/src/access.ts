import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import { isControllerClass } from './router.ts';
import type { RouteDefinition } from './route-definition.ts';
import type { ClassResolver } from './types.ts';

/**
 * A decision about who may call a route: `true` lets the request on, `false` answers 403, and it may throw its own `HttpError`.
 * See docs/authorization.md#authorizing-requests.
 */
export type AccessCheck<TCtx = any> = (ctx: TCtx, resolve: ClassResolver) => boolean | Promise<boolean>;

/** Labels live beside the functions, not on them: a frozen or already labelled function takes one all the same. */
const labels = new WeakMap<object, string>();

/**
 * Gives a check the name `route:list` shows for it. The label `everyone` is reserved for {@link everyone} itself and
 * {@link everyone} cannot carry another, so `route:list` never shows an open route as guarded or the other way round. See docs/authorization.md#authorizing-requests.
 */
export function describeAccess<F extends (...args: any[]) => unknown>(check: F, label: string): F {
  if (((check as unknown) === everyone) !== (label === 'everyone')) {
    throw new TypeError("describeAccess(): the label 'everyone' belongs to everyone alone, and everyone keeps it — pick another label for another check.");
  }
  labels.set(check, label);
  return check;
}

/** The label {@link describeAccess} gave a check — `check` for one without. */
export function accessLabel(check: AccessCheck): string {
  return labels.get(check) ?? 'check';
}

/**
 * The decision that anyone may call the route, signed in or not: `Route.authorize(everyone)` or `defineRequest({ authorize: everyone })`.
 * It never opens a route further than another check allows. See docs/authorization.md#authorizing-requests.
 */
export const everyone: () => true = Object.freeze((): true => true);
labels.set(everyone, 'everyone');

/**
 * The first frame of a stack captured with `Error.captureStackTrace(holder, fn)` as `file:line`, relative to the working
 * directory. `file:` URLs (percent-encoded, as modules report them) become paths.
 */
export function siteOf(stack: string | undefined): string | undefined {
  for (const line of (stack ?? '').split('\n')) {
    const match = /^\s*at (?:.*? \()?(.+?):(\d+):\d+\)?$/.exec(line);
    if (!match) continue;
    const file = match[1]!.startsWith('file:') ? fileURLToPath(match[1]!) : match[1]!;
    const cwd = `${process.cwd()}${sep}`;
    return `${file.startsWith(cwd) ? file.slice(cwd.length) : file}:${match[2]}`;
  }
  return undefined;
}

/**
 * Every check a request to the route passes, in the order they run: the registrar's, then the request's `authorize`
 * of a controller that has one. See docs/authorization.md#authorizing-requests.
 */
export function routeAccess(route: RouteDefinition): readonly AccessCheck[] {
  const own = isControllerClass(route.action) ? route.action.request?.authorize : undefined;
  return own ? Object.freeze([...route.checks, own]) : route.checks;
}

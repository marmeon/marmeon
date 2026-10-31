import { withCode } from '@marmeon/core/internal';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import { isControllerClass } from './router.ts';
import type { RouteDefinition } from './route-definition.ts';
import type { ClassResolver, RouteBinding } from './types.ts';

/**
 * A decision about who may call a route: `true` lets the request on, `false` answers 403, and it may throw its own `HttpError`.
 * See docs/authorization.md#every-route-decides.
 */
export type AccessCheck<TCtx = any> = (ctx: TCtx, resolve: ClassResolver) => boolean | Promise<boolean>;

/**
 * Code a route runs once every check has passed (`Route.afterAuthorize()`). It decides nothing: what it returns is ignored,
 * and a throw answers as a failing check does. See docs/routing.md#after-the-checks.
 */
export type AfterAuthorizeHook<TCtx = any> = (ctx: TCtx, resolve: ClassResolver) => void | Promise<void>;

const EVERYONE = Symbol.for('marmeon.access.everyone');

/** Labels live beside the functions, not on them: a frozen or already labelled function takes one all the same. */
const labels = new WeakMap<object, string>();

/**
 * Gives a check the name `route:list` shows for it. The label `everyone` is reserved for {@link everyone} itself and
 * {@link everyone} cannot carry another, so `route:list` never shows an open route as guarded or the other way round. See docs/authorization.md#every-route-decides.
 */
export function describeAccess<F extends (...args: any[]) => unknown>(check: F, label: string): F {
  if (isEveryone(check) !== (label === 'everyone')) {
    throw new TypeError("describeAccess(): the label 'everyone' belongs to everyone alone, and everyone keeps it — pick another label for another check.");
  }
  labels.set(check, label);
  return check;
}

/** The label {@link describeAccess} gave a check — `check` for one without. */
export function accessLabel(check: AccessCheck): string {
  return isEveryone(check) ? 'everyone' : (labels.get(check) ?? 'check');
}

/**
 * The decision that anyone its middleware lets through may call the route: `Route.authorize(everyone)` or `defineRequest({ authorize: everyone })`.
 * It never opens a route further than another check allows. See docs/authorization.md#every-route-decides.
 */
export const everyone: () => true = (): true => true;
// A brand besides identity: a second installed copy of the package has an `everyone` of its own, and it counts here too.
// Forging the brand only makes a check count as open, which reports more routes, never fewer.
Object.defineProperty(everyone, EVERYONE, { value: true });
Object.freeze(everyone);
labels.set(everyone, 'everyone');

/** Whether the check is {@link everyone}, from this copy of the package or another. */
export function isEveryone(check: unknown): boolean {
  return check === everyone || (typeof check === 'function' && (check as unknown as Record<symbol, unknown>)[EVERYONE] === true);
}

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
 * of a controller that has one. See docs/authorization.md#every-route-decides.
 */
export function routeAccess(route: RouteDefinition): readonly AccessCheck[] {
  const own = isControllerClass(route.action) ? route.action.request?.authorize : undefined;
  return own ? Object.freeze([...route.checks, own]) : route.checks;
}

/**
 * The first line of a stack outside `node_modules` and `node:` as `file:line`, so a route a package registers on behalf of
 * an app is placed in the app's file when the package is installed.
 */
export function userSite(stack: string | undefined): string | undefined {
  return siteOf((stack ?? '').split('\n').filter((line) => !line.includes('node_modules') && !line.includes('node:')).join('\n'));
}

/** Where the route being registered was written: the stack above `caller`, the registrar method the app called. */
export function registrationSite(caller: (...args: never[]) => unknown): string | undefined {
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, caller);
  return userSite(holder.stack);
}

/** A route that does not say who may call it, or one that lets everyone call it and binds a record by its key. */
export type AccessProblem =
  | { readonly kind: 'undecided'; readonly route: RouteDefinition }
  | { readonly kind: 'open-binding'; readonly route: RouteDefinition; readonly param: string; readonly binder: string; readonly write: boolean };

/** The start is refused: routes that do not say who may call them. Its message is the whole report — no stack to read. */
export class RouteAccessError extends Error {
  override name = 'RouteAccessError';
}

/**
 * The message the kernel and `route:types` give for the problems of `Router.accessProblems()`, naming where each route was
 * registered. `path` shows a route's path — a caller that logs it passes it through its redactor. See docs/authorization.md#every-route-decides.
 */
export function formatAccessProblems(problems: readonly AccessProblem[], { path = (route: RouteDefinition) => route.path }: { path?: (route: RouteDefinition) => string } = {}): string {
  const row = (route: RouteDefinition) =>
    [route.methods.join('|'), path(route), route.routeName ?? '-', isControllerClass(route.action) ? route.action.name || 'Controller' : 'Closure', route.site ?? '-'].join('  ');
  const undecided = problems.filter((problem) => problem.kind === 'undecided');
  const open = problems.filter((problem) => problem.kind === 'open-binding');
  const parts: string[] = [];
  if (undecided.length > 0) {
    parts.push(
      `${undecided.length} ${undecided.length === 1 ? 'route does' : 'routes do'} not say who may call ${undecided.length === 1 ? 'it' : 'them'}:`,
      ...undecided.map((problem) => `  ${row(problem.route)}`),
      'Say it with one of these:',
      "  - can(Policy, 'ability', 'param') as the request's `authorize`, or on its registrar: Route.authorize(can(…))",
      '  - a check of your own: Route.authorize((ctx) => …) or `authorize` in defineRequest()',
      '  - everyone, last: Route.authorize(everyone) says anyone its middleware lets through may call it — nothing else about it is checked',
    );
  }
  if (open.length > 0) {
    parts.push(
      `${open.length === 1 ? 'A route lets' : `${open.length} routes let`} everyone call ${open.length === 1 ? 'it' : 'them'} and ${open.length === 1 ? 'binds' : 'bind'} a record that any key finds:`,
      ...open.map((problem) => `  ${row(problem.route)}  lets everyone call it and binds \`${problem.param}\` with ${problem.binder}, which finds any ${problem.param} by its key${problem.kind === 'open-binding' && problem.write ? ' — the route changes data, so it needs a real check, and { public: true } does not excuse it' : ''}`),
      'Do one of these for each:',
      '  - check access with a policy: Route.authorize(can(Policy, …))',
      "  - scope the binding to its parent: bind('child', Binder, { scopedBy: 'parent' })",
      "  - say that every record is public, on a route that only reads: bind('param', Binder, { public: true })",
      "  - decide with a check of your own: Route.authorize(describeAccess((ctx) => …, 'invitation link')) for a token in its path, or (…, 'open event') for a write under a public parent that the check finds open",
    );
  }
  parts.push('See docs/authorization.md#every-route-decides.');
  return withCode('H3', parts.join('\n'));
}

/** Whether a binding looks its record up within a parent — a non-empty name, the same test `bind()` and the router apply. */
export function isScoped(binding: Pick<RouteBinding, 'scopedBy'>): binding is { scopedBy: string } {
  return typeof binding.scopedBy === 'string' && binding.scopedBy !== '';
}

/** Whether the route only reads: a write under `everyone` that binds a record is never excused by `public`. */
function readsOnly(route: RouteDefinition): boolean {
  return route.methods.every((method) => method === 'GET' || method === 'HEAD');
}

/**
 * The bindings of a route that lets everyone call it which find a record for anyone: unscoped ones, and ones scoped by a
 * parent that does (`public` excuses a binding, not the bindings scoped by it). Reported once: a child is left out while its
 * parent, reported itself, is not yet fixed.
 */
export function openBindings(route: RouteDefinition): RouteBinding[] {
  const open: RouteBinding[] = [];
  const state = new Map<string, { anyone: boolean; excused: boolean }>();
  const reads = readsOnly(route);
  for (const binding of route.bindings) {
    const parent = isScoped(binding) ? state.get(binding.scopedBy) : undefined;
    // A parent that is not there cannot be shown to close the binding, so it counts as open.
    const anyone = !isScoped(binding) || (parent?.anyone ?? true);
    const excused = reads && binding.public === true;
    state.set(binding.param, { anyone, excused });
    if (anyone && !excused && (!isScoped(binding) || parent === undefined || parent.excused)) open.push(binding);
  }
  return open;
}

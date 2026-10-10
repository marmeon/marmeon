import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Application } from '@marmeon/core';
import { Router, type RouteDefinition } from '@marmeon/router';

/**
 * Where `marmeon route:types` writes the routes the browser may learn, relative to the app root — read by the
 * `marmeon()` Vite plugin for `virtual:marmeon/routes`. Generated, not committed (like `.marmeon/manifest.json`).
 */
export const BROWSER_ROUTES_FILE = '.marmeon/routes.json';

/** Why a named route never reaches the browser. */
export type HiddenReason = 'internal' | 'api' | 'except';

/** The content of {@link BROWSER_ROUTES_FILE}. */
export interface BrowserRoutes {
  readonly version: 1;
  /**
   * The routes the browser may learn — the named `web` routes and `clientRoutes.include`, without `.internal()` routes
   * and `clientRoutes.except`. A client build ships only those its code names; the SSR renderer gets all of them.
   */
  readonly routes: Readonly<Record<string, BrowserRoute>>;
  /** The other named routes and why they stay on the server — for the build's error messages only, never bundled. */
  readonly hidden: Readonly<Record<string, HiddenReason>>;
}

/** One route the browser may learn. */
export interface BrowserRoute {
  readonly method: string;
  readonly path: string;
  /**
   * The page its controller renders, when that is written out once in it (`this.view('user-profile/Show', …)` — not a layer, an
   * island or a computed name): an instant visit (`<Link instant>`) shows that view's placeholder before the answer.
   */
  readonly view?: string;
}

/** Which named routes the browser may learn (`clientRoutes` of `defineApplication`). */
export interface ClientRoutesOptions {
  readonly include?: readonly string[];
  readonly except?: readonly string[];
}

/**
 * Sorts the named routes into those the browser may learn and those it never does: `.internal()` routes first (nothing
 * brings them back), then `clientRoutes.except`, then everything outside the `web` group not in `clientRoutes.include`.
 */
export function browserRoutes(routes: readonly RouteDefinition[], { include = [], except = [] }: ClientRoutesOptions = {}): BrowserRoutes {
  const named = routes
    .filter((route): route is RouteDefinition & { routeName: string } => route.routeName !== undefined)
    .sort((a, b) => (a.routeName < b.routeName ? -1 : 1));
  const allowed: Record<string, BrowserRoute> = {};
  const hidden: Record<string, HiddenReason> = {};
  for (const route of named) {
    const reason = hiddenReason(route, include, except);
    if (reason) hidden[route.routeName] = reason;
    else {
      const view = route.methods.includes('GET') ? staticView(route.action) : undefined;
      allowed[route.routeName] = { method: route.methods[0]!.toLowerCase(), path: route.path, ...(view ? { view } : {}) };
    }
  }
  return { version: 1, routes: allowed, hidden };
}

/** `this.view('a/B'` with a literal name — what a controller's `handle` renders. */
const VIEW_CALL = /\bthis\.view\(\s*(['"`])([\w./-]+)\1/g;

/**
 * The page a controller renders, read from its `handle` (instant visits): exactly one view name written out, and the
 * result is a page — no layer (`.layer(`), no island. Anything else (a closure, two views, a name built at runtime): none, and
 * an instant visit of the route simply waits for its answer.
 */
export function staticView(action: unknown): string | undefined {
  const handle = typeof action === 'function' ? (action as { prototype?: { handle?: unknown } }).prototype?.handle : undefined;
  if (typeof handle !== 'function') return undefined;
  const source = Function.prototype.toString.call(handle);
  if (/\.layer\(|\bthis\.island\(/.test(source)) return undefined;
  const views = new Set([...source.matchAll(VIEW_CALL)].map((match) => match[2]!));
  return views.size === 1 ? [...views][0] : undefined;
}

function hiddenReason(route: RouteDefinition & { routeName: string }, include: readonly string[], except: readonly string[]): HiddenReason | undefined {
  if (route.isInternal) return 'internal';
  if (matchesRoutePatterns(route.routeName, except)) return 'except';
  if (route.group !== 'web' && !matchesRoutePatterns(route.routeName, include)) return 'api';
  return undefined;
}

/** `*` matches anything (dots included), like Ziggy's patterns: `admin.*`. */
export function matchesRoutePatterns(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(name));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Writes {@link BROWSER_ROUTES_FILE} under `root` when its content changed — atomically, as the dev server, `marmeon`
 * commands and test workers may write it at once. Returns whether it changed.
 */
export function writeBrowserRoutes(root: string, routes: BrowserRoutes): boolean {
  const path = join(root, BROWSER_ROUTES_FILE);
  const content = `${JSON.stringify(routes, null, 2)}\n`;
  try {
    if (readFileSync(path, 'utf8') === content) return false;
  } catch {
    // not written yet
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
  return true;
}

/** Writes the booted app's {@link BROWSER_ROUTES_FILE} — what `marmeon route:types` does, for server rendering in tests. */
export function writeAppBrowserRoutes(app: Application): boolean {
  return writeBrowserRoutes(app.root, browserRoutes(app.container.make(Router).routes, app.options.clientRoutes));
}

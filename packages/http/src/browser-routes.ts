import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Application } from '@bespokecore/core';
import { Router, type RouteDefinition } from '@bespokecore/router';

/**
 * Where `bespoke route:types` writes the routes the browser may learn, relative to the app root — read by the
 * `bespoke()` Vite plugin for `virtual:bespoke/routes`. Generated, not committed (like `.bespoke/manifest.json`).
 */
export const BROWSER_ROUTES_FILE = '.bespoke/routes.json';

/** Why a named route never reaches the browser. */
export type HiddenReason = 'internal' | 'api' | 'except';

/** The content of {@link BROWSER_ROUTES_FILE}. */
export interface BrowserRoutes {
  readonly version: 1;
  /**
   * The routes the browser may learn — the named `web` routes and `clientRoutes.include`, without `.internal()` routes
   * and `clientRoutes.except`. A client build ships only those its code names (E57); the SSR renderer gets all of them.
   */
  readonly routes: Readonly<Record<string, { readonly method: string; readonly path: string }>>;
  /** The other named routes and why they stay on the server — for the build's error messages only, never bundled. */
  readonly hidden: Readonly<Record<string, HiddenReason>>;
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
  const allowed: Record<string, { method: string; path: string }> = {};
  const hidden: Record<string, HiddenReason> = {};
  for (const route of named) {
    const reason = hiddenReason(route, include, except);
    if (reason) hidden[route.routeName] = reason;
    else allowed[route.routeName] = { method: route.methods[0]!.toLowerCase(), path: route.path };
  }
  return { version: 1, routes: allowed, hidden };
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
 * Writes {@link BROWSER_ROUTES_FILE} under `root` when its content changed — atomically, as the dev server, `bespoke`
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

/** Writes the booted app's {@link BROWSER_ROUTES_FILE} — what `bespoke route:types` does, for server rendering in tests. */
export function writeAppBrowserRoutes(app: Application): boolean {
  return writeBrowserRoutes(app.root, browserRoutes(app.container.make(Router).routes, app.options.clientRoutes));
}

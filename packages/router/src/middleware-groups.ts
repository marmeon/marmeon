import { assertMiddleware } from './middleware.ts';
import type { AnyMiddleware } from './types.ts';

/**
 * Where framework middleware sits in a group. Packages register in any order;
 * the priority decides the order they run in (lower first). App middleware
 * defaults to `app`, after everything the framework adds.
 */
export const MiddlewarePriority = {
  encryptCookies: 100,
  /** Outside the session: it sees the route's own response (http's `ClearClientHistory`). */
  clearClientHistory: 150,
  startSession: 200,
  /** Inside the session, around everything that may answer for a signed-in user (auth's `NoStoreWhenSignedIn`). */
  preventCaching: 210,
  /** The request's locale (@marmeon/i18n's `SetLocale`): after the session it reads, before anything that answers with text (CSRF's 419). */
  setLocale: 220,
  checkAssetVersion: 250,
  verifyCsrfToken: 300,
  shareProps: 400,
  app: 1000,
  /**
   * The global stack's last (cache's `LimitLiveValidation`): after the app's own global middleware — its security headers
   * go on a `429` too — and before any group's.
   */
  limitLiveValidation: 1100,
} as const;

/** The group every request passes, found or not. */
export const GLOBAL = 'global';

interface Entry {
  readonly middleware: AnyMiddleware;
  readonly priority: number;
}

/**
 * Named middleware groups (`web`, `api`) plus the global stack.
 * Execution order for a route: global → its group → the route's own middleware.
 */
export class MiddlewareGroups {
  readonly #groups = new Map<string, Entry[]>();
  /** Each group in order, as `get` answers it — sorted once, not on every request; any change starts over. */
  readonly #sorted = new Map<string, readonly AnyMiddleware[]>();
  #version = 0;

  /** Adds middleware to a group; equal priorities keep the order they were added in. */
  append(group: string, middleware: AnyMiddleware, priority: number = MiddlewarePriority.app): this {
    assertMiddleware(middleware, `MiddlewareGroups.append('${group}')`);
    // Untyped code gets past the signature: append('web', a, b) would make `b` the priority.
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      throw new TypeError(`MiddlewareGroups.append('${group}') takes a finite number as priority — got ${String(priority)}. One middleware per call.`);
    }
    const entries = this.#groups.get(group) ?? [];
    this.#groups.set(group, [...entries.filter((entry) => entry.middleware !== middleware), { middleware, priority }]);
    this.#changed();
    return this;
  }

  remove(group: string, middleware: AnyMiddleware): this {
    this.#groups.set(group, (this.#groups.get(group) ?? []).filter((entry) => entry.middleware !== middleware));
    this.#changed();
    return this;
  }

  get(group: string): readonly AnyMiddleware[] {
    let sorted = this.#sorted.get(group);
    if (!sorted) {
      // Array#sort is stable, so insertion order breaks ties.
      sorted = Object.freeze([...(this.#groups.get(group) ?? [])].sort((a, b) => a.priority - b.priority).map((entry) => entry.middleware));
      this.#sorted.set(group, sorted);
    }
    return sorted;
  }

  /** Counts the changes — what `Router.middlewareFor` keeps its per-route lists by. */
  get version(): number {
    return this.#version;
  }

  #changed(): void {
    this.#sorted.clear();
    this.#version++;
  }

  names(): string[] {
    return [...this.#groups.keys()];
  }
}

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
  checkAssetVersion: 250,
  verifyCsrfToken: 300,
  shareProps: 400,
  app: 1000,
} as const;

/** The group every request passes, found or not. */
export const GLOBAL = 'global';

interface Entry {
  readonly middleware: AnyMiddleware;
  readonly priority: number;
}

/**
 * Named middleware groups (Laravel's `web` / `api`) plus the global stack.
 * Execution order for a route: global → its group → the route's own middleware.
 */
export class MiddlewareGroups {
  readonly #groups = new Map<string, Entry[]>();

  /** Adds middleware to a group; equal priorities keep the order they were added in. */
  append(group: string, middleware: AnyMiddleware, priority: number = MiddlewarePriority.app): this {
    const entries = this.#groups.get(group) ?? [];
    this.#groups.set(group, [...entries.filter((entry) => entry.middleware !== middleware), { middleware, priority }]);
    return this;
  }

  remove(group: string, middleware: AnyMiddleware): this {
    this.#groups.set(group, (this.#groups.get(group) ?? []).filter((entry) => entry.middleware !== middleware));
    return this;
  }

  get(group: string): readonly AnyMiddleware[] {
    // Array#sort is stable, so insertion order breaks ties.
    return [...(this.#groups.get(group) ?? [])].sort((a, b) => a.priority - b.priority).map((entry) => entry.middleware);
  }

  names(): string[] {
    return [...this.#groups.keys()];
  }
}

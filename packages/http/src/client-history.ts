import type { HttpContext, MiddlewareClass, Next } from '@bespokecore/router';
import { LOCATION_HEADER, PAGE_HEADER } from './page.ts';

/**
 * Ends the browser's page session of this app with the current response — what signing in and out need
 * (`Auth` calls it; so can an app that switches accounts or impersonates). The client keeps the pages it
 * showed in memory, to go back without a request; after `clear()`, none of them may come back:
 *
 * - A client-side visit (`x-bespoke`) is answered with `409` and `x-bespoke-location` — the same answer as a
 *   new build (asset versioning) — so the browser loads the next page **fully**. The old document, and the
 *   in-memory page cache with it, is gone; every earlier history entry is fetched from the server again.
 * - With `{ siteCache: true }` (sign-out), the response also carries `Clear-Site-Data: "cache"`: the
 *   browser drops what its HTTP cache holds for the site.
 *
 * Inertia's `clearHistory()` / `Inertia::location()`, made automatic.
 */
export class ClientHistory {
  #cleared = false;
  #siteCache = false;

  clear(options: { siteCache?: boolean } = {}): void {
    this.#cleared = true;
    if (options.siteCache) this.#siteCache = true;
  }

  get cleared(): boolean {
    return this.#cleared;
  }

  get clearsSiteCache(): boolean {
    return this.#siteCache;
  }
}

/** Headers of a page or redirect that make no sense on the bodiless 409 that replaces it. */
const DROPPED = ['location', 'content-type', 'content-length', PAGE_HEADER];

/**
 * Applies {@link ClientHistory} to the response — in the `web` group, outside the session, so the session
 * sees the response the route gave (a 303, not a reload: `StartSession` keeps flash data through a 409).
 *
 * The full page load goes where the response was headed: a redirect's `Location`, otherwise the requested
 * page (a GET). Sign in and out with a redirect — what a page rendered on a POST shows is lost in the reload.
 */
export class ClearClientHistory {
  readonly #history: ClientHistory;

  constructor(history: ClientHistory) {
    this.#history = history;
  }

  async handle(ctx: HttpContext, next: Next<{}>): Promise<Response> {
    const response = await next();
    if (!this.#history.cleared) return response;

    const headers = new Headers(response.headers);
    if (this.#history.clearsSiteCache) headers.set('clear-site-data', '"cache"');
    if (ctx.request.headers.get(PAGE_HEADER) !== 'true') {
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    const url = new URL(ctx.request.url);
    const redirect = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    const location = redirect ?? url.pathname + url.search;
    await response.body?.cancel();
    for (const name of DROPPED) headers.delete(name);
    headers.set(LOCATION_HEADER, location);
    return new Response(null, { status: 409, headers });
  }
}

/**
 * Sets `Cache-Control` on the route's responses that do not set it themselves — e.g. to let the browser keep a
 * page that `@bespokecore/auth` would otherwise mark `no-store` for signed-in users:
 * `Route.middleware(cacheControl('private, max-age=60')).get('/report.pdf', ShowReportController)`.
 * Never `public` for what depends on the user: shared caches (proxies, CDNs) would hand it to others.
 */
export function cacheControl(value: string): MiddlewareClass<{}, {}> {
  const CacheControl = class {
    async handle(_ctx: HttpContext, next: Next<{}>): Promise<Response> {
      const response = await next();
      if (response.headers.has('cache-control')) return response;
      const cached = new Response(response.body, response);
      cached.headers.set('cache-control', value);
      return cached;
    }
  };
  Object.defineProperty(CacheControl, 'name', { value: 'cacheControl' });
  return CacheControl;
}

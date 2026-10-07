import { editableResponse, ownResponse, type HttpContext, type MiddlewareClass, type Next } from '@marmeon/router';
import { isActionRequest, LOCATION_HEADER, PAGE_HEADER, RELOAD_HEADER } from './page.ts';

/**
 * Ends the browser's page session of this app with the current response — what signing in and out need
 * (`Auth` calls it; so can an app that switches accounts or impersonates). The client keeps the pages it
 * showed in memory, to go back without a request; after `clear()`, none of them may come back:
 *
 * - A client-side visit (`x-marmeon`) is answered with `409` and `x-marmeon-location` — the same answer as a
 *   new build (asset versioning) — so the browser loads the next page **fully**. The old document, and the
 *   in-memory page cache with it, is gone; every earlier history entry is fetched from the server again.
 * - With `{ siteData: true }` (sign-out — `Auth.logout()` asks for it, E165), the response also carries
 *   `Clear-Site-Data: "cache", "storage"`: the browser drops what its HTTP cache holds for the site and the site's storage
 *   (`localStorage`, `sessionStorage`, IndexedDB, service workers) — in every tab. `siteData: ['cache']` drops the cache alone
 *   (a language switch); `siteData: false` takes back what an earlier call asked for (the last call wins). Never `"cookies"`
 *   (the response sets the session's own) and never `"executionContexts"` (no browser does it; the other tabs let go of
 *   their memory through the tabSync feature).
 *
 * Inertia's `clearHistory()` / `Inertia::location()`, made automatic.
 */
export class ClientHistory {
  #cleared = false;
  #siteData: readonly SiteData[] = [];

  clear(options: { siteData?: boolean | readonly SiteData[] } = {}): void {
    this.#cleared = true;
    const { siteData } = options;
    if (siteData !== undefined) this.#siteData = siteData === true ? ['cache', 'storage'] : siteData === false ? [] : [...new Set(siteData)];
  }

  get cleared(): boolean {
    return this.#cleared;
  }

  /** What the response's `Clear-Site-Data` names — empty: no header. */
  get siteData(): readonly SiteData[] {
    return this.#siteData;
  }
}

/** What `Clear-Site-Data` may name here: the HTTP cache and the site's storage (E165). */
export type SiteData = 'cache' | 'storage';

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
    const siteData = this.#history.siteData;
    if (siteData.length > 0) headers.set('clear-site-data', siteData.map((type) => `"${type}"`).join(', '));
    // An action (E59) too: signing out through one must not leave the pages in memory either.
    const action = isActionRequest(ctx.request);
    if (ctx.request.headers.get(PAGE_HEADER) !== 'true' && !action) {
      return ownResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
    }

    const url = new URL(ctx.request.url);
    const redirect = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    // An action's own URL is no page: without a redirect, the page it was sent from (this site's `Referer`), else the start.
    const location = redirect ?? (action ? refererPath(ctx.request) : url.pathname + url.search);
    await response.body?.cancel();
    for (const name of DROPPED) headers.delete(name);
    headers.set(LOCATION_HEADER, location);
    // A document change (E64), never a new build: whatever the response it replaces said (a version check's 409 that ran after a
    // sign-in of this request, say), the client may not postpone this one — `version` is the only cancelable reason.
    headers.set(RELOAD_HEADER, 'history');
    return ownResponse(new Response(null, { status: 409, headers }));
  }
}

/** The path of the page `request` came from — when it is this site's; else `/`. */
function refererPath(request: Request): string {
  const referer = request.headers.get('referer');
  if (!referer) return '/';
  try {
    const from = new URL(referer);
    return from.origin === new URL(request.url).origin ? from.pathname + from.search : '/';
  } catch {
    return '/';
  }
}

/**
 * Sets `Cache-Control` on the route's responses that do not set it themselves — e.g. to let the browser keep a
 * page that `@marmeon/auth` would otherwise mark `no-store` for signed-in users:
 * `Route.middleware(cacheControl('private, max-age=60')).get('/report.pdf', ShowReportController)`.
 * Never `public` for what depends on the user: shared caches (proxies, CDNs) would hand it to others.
 */
export function cacheControl(value: string): MiddlewareClass<{}, {}> {
  const CacheControl = class {
    async handle(_ctx: HttpContext, next: Next<{}>): Promise<Response> {
      const response = await next();
      if (response.headers.has('cache-control')) return response;
      const cached = editableResponse(response);
      cached.headers.set('cache-control', value);
      return cached;
    }
  };
  Object.defineProperty(CacheControl, 'name', { value: 'cacheControl' });
  return CacheControl;
}

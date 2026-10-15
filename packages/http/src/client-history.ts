import { localLocation } from '@marmeon/router/internal';
import { editableResponse, ownResponse, type HttpContext, type MiddlewareClass, type Next } from '@marmeon/router';
import { isActionRequest, LOCATION_HEADER, PAGE_HEADER, RELOAD_HEADER } from './page.ts';

/**
 * Ends the browser's page session of this app with the current response — what signing in and out need (`Auth` calls it).
 * After `clear()`, no page the client keeps in memory may come back: a client-side visit is answered with `409` and
 * `x-marmeon-location`, so the browser loads the next page fully.
 *
 * `{ siteData: ['storage'] }` (what `Auth.logout()` asks for) also sends `Clear-Site-Data: "storage"`; `true` is `"cache", "storage"`,
 * `['cache']` the cache alone, `false` takes back an earlier call's. Naming `"cache"` makes Chrome scan its
 * whole disk cache, all sites, before it goes on: seconds on a busy profile. Browsers honour the header in secure contexts
 * (HTTPS, `http://localhost`). Never `"cookies"` (the response sets the session's own), nor `"executionContexts"` (no browser
 * does it; tab sync clears the other tabs). See docs/client-features.md#the-browsers-storage-on-sign-out.
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

/** What `Clear-Site-Data` may name here: the HTTP cache and the site's storage. */
export type SiteData = 'cache' | 'storage';

/** Headers of a page or redirect that make no sense on the bodiless 409 that replaces it. */
const DROPPED = ['location', 'content-type', 'content-length', PAGE_HEADER];

/**
 * Applies {@link ClientHistory} to the response — in the `web` group, outside the session, so the session sees the response
 * the route gave (a 303, not a reload: `StartSession` keeps flash data through a 409). The full load goes where the response
 * was headed: a redirect's `Location`, else the requested page — sign in and out with a redirect.
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
    // An action too: signing out through one must not leave the pages in memory either.
    const action = isActionRequest(ctx.request);
    if (ctx.request.headers.get(PAGE_HEADER) !== 'true' && !action) {
      return ownResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
    }

    const url = new URL(ctx.request.url);
    const redirect = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    // An action's own URL is no page: without a redirect, the page it was sent from (this site's `Referer`), else the start.
    const location = redirect ?? (action ? refererPath(ctx.request) : localLocation(url.pathname, url.search));
    await response.body?.cancel();
    for (const name of DROPPED) headers.delete(name);
    headers.set(LOCATION_HEADER, location);
    // A document change, never a new build: whatever the response it replaces said (a version check's 409 that ran after a
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
    return from.origin === new URL(request.url).origin ? localLocation(from.pathname, from.search) : '/';
  } catch {
    return '/';
  }
}

/**
 * Sets `Cache-Control` on the route's responses that do not set it themselves — e.g. to let the browser keep a
 * page that `@marmeon/auth` would otherwise mark `no-store` for signed-in users:
 * `Route.middleware(cacheControl('private, max-age=60')).get('/report.pdf', ShowReportController)`.
 * Never `public` for what depends on the user: shared caches (proxies, CDNs) would hand it to others. The answer outlives a
 * sign-out in the browser's cache: such an app signs out with `history.clear({ siteData: ['cache', 'storage'] })`.
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

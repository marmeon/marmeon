/**
 * The UI-free core of the client: visits, the browser history and the in-memory page cache (E36).
 * No React in here — `<BespokeApp>` renders what the navigator hands it (and Wave 5's adapter core,
 * `@bespokecore/http/client`, will start from this file).
 */
import { isPageObject, LOCATION_HEADER, PAGE_HEADER, VERSION_HEADER, type PageObject } from '@bespokecore/http/page';

export type VisitMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface VisitOptions {
  /** Default `get`. Other methods send `data` and the CSRF token (`X-XSRF-TOKEN`). */
  method?: VisitMethod;
  /** Sent as JSON — or as multipart when it is a `FormData` (file uploads). For `get`, as query string. */
  data?: Record<string, unknown> | FormData;
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Keep the scroll position (default: scroll to the top on a new page). */
  preserveScroll?: boolean;
  /**
   * Keep component state (form input, open panels) when the same page component
   * comes back. Default: true for non-GET visits — a form that failed validation
   * keeps what was typed — false for GET visits.
   */
  preserveState?: boolean;
  headers?: Record<string, string>;
}

/**
 * What a history entry holds — where it is, never what it showed (E36). Browsers write `history.state` to
 * disk for session restore, and it outlives a sign-out; the page object (its props) lives only in this tab's
 * memory, under `key`. An entry whose page is not in memory (after a reload, a session restore, or evicted)
 * is fetched from the server again, which checks who is asking.
 */
export interface HistoryState {
  readonly component: string;
  readonly url: string;
  /** The window's scroll position when the entry was left. */
  readonly scroll: { readonly x: number; readonly y: number };
  /** The entry's page in the in-memory cache — random, so entries of an earlier document never match. */
  readonly key: string;
}

export function isHistoryState(value: unknown): value is HistoryState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.key === 'string' && typeof state.url === 'string' && typeof state.component === 'string' && !('props' in state);
}

/** The parts of `window` the navigator uses (a fake one in tests). */
export interface NavigatorWindow {
  readonly history: Pick<History, 'state' | 'pushState' | 'replaceState'>;
  readonly location: Pick<Location, 'href' | 'origin' | 'pathname' | 'search' | 'assign' | 'replace' | 'reload'>;
  readonly scrollX: number;
  readonly scrollY: number;
  scrollTo(x: number, y: number): void;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  addEventListener(type: 'popstate' | 'pageshow', listener: (event: Event) => void): void;
  removeEventListener(type: 'popstate' | 'pageshow', listener: (event: Event) => void): void;
}

export interface NavigatorOptions {
  /** The page the server rendered (from `#bespoke-page`) — always fresh: a full load asks the server. */
  initialPage: PageObject;
  /** Shows a page: resolve its component and render it. */
  render: (page: PageObject, options: { preserveState: boolean }) => Promise<void>;
  /** Default: the browser's `window`. */
  window?: NavigatorWindow;
  /** Pages kept in memory, one per history entry; the least recently shown goes first. Default 20. */
  cacheSize?: number;
}

/** How many pages the in-memory cache keeps by default. */
export const DEFAULT_PAGE_CACHE_SIZE = 20;

/**
 * Navigates without full page loads: a visit fetches the next page object as JSON (`x-bespoke`), keeps it
 * in memory and pushes a history entry *without* its props. Back and Forward show the page from memory —
 * or ask the server when it is not there. A `409` with `x-bespoke-location` (a new build, or signing in
 * or out — `ClientHistory` on the server) loads that URL fully and drops every page kept in memory.
 */
export class Navigator {
  readonly #window: NavigatorWindow;
  readonly #render: NavigatorOptions['render'];
  readonly #cache: PageCache;
  /** The asset version this tab runs — the one of the page it was loaded with. */
  readonly #version: string | null;
  #page: PageObject;
  #key: string | undefined;
  #inFlight: AbortController | undefined;
  /** This document was left for a full page load (409, a response that is not a page). */
  #left = false;

  constructor({ initialPage, render, window: win = globalThis.window, cacheSize = DEFAULT_PAGE_CACHE_SIZE }: NavigatorOptions) {
    this.#window = win;
    this.#render = render;
    this.#cache = new PageCache(cacheSize);
    this.#page = initialPage;
    this.#version = initialPage.version ?? null;
  }

  /** The page on screen. */
  get page(): PageObject {
    return this.#page;
  }

  /** How many pages are kept in memory (tests). */
  get cachedPages(): number {
    return this.#cache.size;
  }

  /** Takes over the history (Back/Forward, the back/forward cache). Returns the function that stops it. */
  start(): () => void {
    this.#adopt();
    this.#window.addEventListener('popstate', this.#onPopState);
    this.#window.addEventListener('pageshow', this.#onPageShow);
    return () => {
      this.#window.removeEventListener('popstate', this.#onPopState);
      this.#window.removeEventListener('pageshow', this.#onPageShow);
    };
  }

  /** Resolves with the page the visit ended on (undefined if the browser took over). */
  async visit(url: string, options: VisitOptions = {}): Promise<PageObject | undefined> {
    this.#adopt();
    const { method = 'get', data, replace = false, preserveScroll = false, headers = {} } = options;
    const preserveState = options.preserveState ?? method !== 'get';

    const target = new URL(url, this.#window.location.href);
    if (target.origin !== this.#window.location.origin) {
      // Another site: the browser goes there. Visits only ever read answers of this one.
      this.#leave();
      this.#window.location.assign(target.href);
      return undefined;
    }

    const request = buildRequest(target, method, data);
    const page = await this.#fetch(request.url, { method, headers: { ...request.headers, ...headers }, body: request.body, replace });
    if (!page) return undefined;
    // Redirected back to the same URL (a failed form): replace, don't stack history entries.
    const sameUrl = page.url === this.#window.location.pathname + this.#window.location.search;
    await this.#show(page, replace || (method !== 'get' && sameUrl) ? 'replace' : 'push', { preserveScroll, preserveState });
    return page;
  }

  /** The entry the document was loaded into gets a key, and its page goes into the cache. */
  #adopt(): void {
    if (this.#key !== undefined) return;
    const state: unknown = this.#window.history.state;
    // A reload or session restore keeps the entry's key (and scroll); the page itself came fresh from the server.
    const restored = isHistoryState(state) ? state : undefined;
    this.#key = restored?.key ?? newKey();
    this.#cache.set(this.#key, this.#page);
    this.#window.history.replaceState(entry(this.#page, this.#key, restored?.scroll ?? { x: 0, y: 0 }), '', this.#window.location.href);
  }

  async #show(page: PageObject, history: 'push' | 'replace', { preserveScroll, preserveState }: { preserveScroll: boolean; preserveState: boolean }) {
    const scroll = { x: this.#window.scrollX, y: this.#window.scrollY };
    await this.#render(page, { preserveState });
    const { history: browserHistory } = this.#window;
    if (history === 'push') {
      // Remember where the page being left was scrolled to (restored on Back by the scroll handling of step 4).
      browserHistory.replaceState(entry(this.#page, this.#key!, scroll), '', this.#window.location.href);
      this.#key = newKey();
      browserHistory.pushState(entry(page, this.#key, { x: 0, y: 0 }), '', page.url);
    } else {
      browserHistory.replaceState(entry(page, this.#key!, preserveScroll ? scroll : { x: 0, y: 0 }), '', page.url);
    }
    this.#cache.set(this.#key!, page);
    this.#page = page;
    if (!preserveScroll) this.#window.scrollTo(0, 0);
  }

  readonly #onPopState = (event: Event): void => {
    const state: unknown = (event as PopStateEvent).state;
    // `null`: an entry of a fragment link (`#section`) on the same page.
    if (state === null || state === undefined) return;
    this.#inFlight?.abort();
    if (isHistoryState(state)) {
      const cached = this.#cache.get(state.key);
      if (cached) {
        this.#key = state.key;
        this.#page = cached;
        void this.#render(cached, { preserveState: false });
        return;
      }
      void this.#restore(state.url, state.key, state.scroll);
      return;
    }
    // An entry of an older client, which kept whole pages in the history: never shown — the server is asked.
    if (isPageObject(state)) void this.#restore(state.url, newKey(), { x: 0, y: 0 });
  };

  /** Back/Forward to an entry whose page is not in memory: the server decides what it shows now. */
  async #restore(url: string, key: string, scroll: HistoryState['scroll']): Promise<void> {
    try {
      const page = await this.#fetch(url, { method: 'get', headers: {}, replace: true });
      if (!page) return;
      await this.#render(page, { preserveState: false });
      // Signed out meanwhile? Then the server sent the login page — and the entry is the login page now.
      this.#window.history.replaceState(entry(page, key, scroll), '', page.url);
      this.#key = key;
      this.#cache.set(key, page);
      this.#page = page;
    } catch {
      // The server cannot be asked (offline, an error): let the browser load the entry itself.
      this.#leave();
      this.#window.location.reload();
    }
  }

  readonly #onPageShow = (event: Event): void => {
    // Back into this document from the back/forward cache, after it was left for a full page load (signing
    // out, say): what it still shows may not be for whoever is here now. Ask the server.
    if ((event as PageTransitionEvent).persisted && this.#left) this.#window.location.reload();
  };

  /**
   * One request for a page object. A newer request always wins over a slower, older one (it aborts it;
   * the aborted one resolves with undefined). Undefined, too, when the browser takes over.
   */
  async #fetch(
    url: string,
    { method, headers, body, replace }: { method: VisitMethod; headers: Record<string, string>; body?: BodyInit; replace: boolean },
  ): Promise<PageObject | undefined> {
    this.#inFlight?.abort();
    const controller = new AbortController();
    this.#inFlight = controller;
    try {
      const response = await this.#window.fetch(url, {
        method: method.toUpperCase(),
        headers: { [PAGE_HEADER]: 'true', ...(this.#version ? { [VERSION_HEADER]: this.#version } : {}), ...headers },
        body,
        signal: controller.signal,
      });
      const location = response.status === 409 ? response.headers.get(LOCATION_HEADER) : null;
      if (location) {
        // A new build, or signing in or out: load the page fully. The pages in memory go with this document.
        this.#leave();
        if (replace) this.#window.location.replace(location);
        else this.#window.location.assign(location);
        return undefined;
      }
      if (response.headers.get(PAGE_HEADER) !== 'true') {
        // Not a page (e.g. a 401 JSON or a file download): let the browser handle it.
        this.#leave();
        this.#window.location.assign(response.url);
        return undefined;
      }
      return (await response.json()) as PageObject;
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      throw error;
    } finally {
      if (this.#inFlight === controller) this.#inFlight = undefined;
    }
  }

  /** Before a full page load: nothing kept in memory survives it, should the browser bring this document back. */
  #leave(): void {
    this.#left = true;
    this.#cache.clear();
  }
}

function entry(page: PageObject, key: string, scroll: HistoryState['scroll']): HistoryState {
  return { component: page.component, url: page.url, scroll, key };
}

function newKey(): string {
  // Not crypto.randomUUID(): that exists only in secure contexts (not on http://192.168.…).
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Page objects by history key, least recently used first out. */
class PageCache {
  readonly #pages = new Map<string, PageObject>();
  readonly #size: number;

  constructor(size: number) {
    this.#size = Math.max(1, size);
  }

  get size(): number {
    return this.#pages.size;
  }

  get(key: string): PageObject | undefined {
    const page = this.#pages.get(key);
    if (page) this.set(key, page);
    return page;
  }

  set(key: string, page: PageObject): void {
    this.#pages.delete(key);
    this.#pages.set(key, page);
    for (const oldest of this.#pages.keys()) {
      if (this.#pages.size <= this.#size) break;
      this.#pages.delete(oldest);
    }
  }

  clear(): void {
    this.#pages.clear();
  }
}

/** The CSRF token the server put into the readable `XSRF-TOKEN` cookie. */
export function xsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

function buildRequest(target: URL, method: VisitMethod, data: VisitOptions['data']): { url: string; headers: Record<string, string>; body?: BodyInit } {
  if (method === 'get') {
    if (data && !(data instanceof FormData)) {
      for (const [key, value] of Object.entries(data)) if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
    return { url: target.pathname + target.search + target.hash, headers: {} };
  }
  const url = target.pathname + target.search + target.hash;
  const token = xsrfToken();
  const headers: Record<string, string> = token ? { 'x-xsrf-token': token } : {};
  if (data instanceof FormData) return { url, headers, body: data }; // the browser sets the multipart boundary
  return { url, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) };
}

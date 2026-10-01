/**
 * The heart of the UI-free client core (`@bespokecore/http/client`): visits and their events, the browser history,
 * the in-memory page cache (E36), partial reloads, deferred and merged props, prefetching and scroll restoration.
 * No UI framework in here — an adapter (`<BespokeApp>` of @bespokecore/react) renders what the navigator hands it.
 */
import {
  isPageObject,
  LOCATION_HEADER,
  PAGE_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PURPOSE_HEADER,
  VERSION_HEADER,
  type PageObject,
  type ValidationErrors,
} from '../page.ts';
import { QueryState, type QueryStateOptions } from './query-state.ts';

export type VisitMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * One request of the navigator: a visit, a reload, Back/Forward to a page that is not in memory — or, `async`, one
 * in the background (deferred props, a poll, `visit({ async: true })`): no progress bar, it neither cancels visits
 * nor is cancelled by them.
 */
export interface Visit {
  readonly url: string;
  readonly method: VisitMethod;
  readonly async?: boolean;
}

/** How far the upload of a `FormData` visit is. `total` and `percentage` are undefined when the size is unknown. */
export interface VisitProgress {
  readonly loaded: number;
  readonly total: number | undefined;
  readonly percentage: number | undefined;
}

/**
 * A visit that failed (E44: `exception`, as in Inertia) — the page stays as it is (nothing typed is lost) and the
 * app shows a fallback:
 * - `network`: the server could not be reached (offline, the server is down, the connection broke).
 * - `server`: the server answered with a 5xx — its error page (`page`, with the exception in debug mode) or, from
 *   something in front of it (a proxy), plain HTML (`html`).
 *
 * Validation errors are no failure: they are the `error` event (the page's `errors` prop, see `useForm`).
 */
export type VisitException =
  | { readonly type: 'network'; readonly visit: Visit; readonly cause: unknown }
  | { readonly type: 'server'; readonly visit: Visit; readonly status: number; readonly page: PageObject | undefined; readonly html: string | undefined };

/**
 * The events of a visit, in order: `start`, `progress` (uploads), then one of `success`, `error`, `exception` or
 * `cancel`, and always `finish` — Inertia's names and meanings (E44). Back/Forward to a page that is not in memory
 * and loading deferred props report `start`, `exception`/`cancel` and `finish` only (they are no visits of the
 * app's own); an `async` visit of the app (a poll) reports all of them. Prefetches report nothing.
 */
export interface VisitEvents {
  start: (visit: Visit) => void;
  progress: (progress: VisitProgress, visit: Visit) => void;
  /** The visit ended on a page without validation errors. */
  success: (page: PageObject, visit: Visit) => void;
  /** The visit ended on a page with validation errors (its `errors` prop — the server redirected back to the form). */
  error: (errors: ValidationErrors, visit: Visit) => void;
  /** The request failed: offline or a 5xx. The page stays; the app shows a fallback. */
  exception: (exception: VisitException) => void;
  /** A newer visit (or Back/Forward) replaced this one before it finished. */
  cancel: (visit: Visit) => void;
  finish: (visit: Visit) => void;
}

export type VisitEvent = keyof VisitEvents;

export interface VisitCallbacks {
  onStart?: VisitEvents['start'];
  onProgress?: VisitEvents['progress'];
  onSuccess?: VisitEvents['success'];
  onError?: VisitEvents['error'];
  onException?: VisitEvents['exception'];
  onCancel?: VisitEvents['cancel'];
  onFinish?: VisitEvents['finish'];
}

export interface VisitOptions extends VisitCallbacks {
  /** Default `get`. Other methods send `data` and the CSRF token (`X-XSRF-TOKEN`). */
  method?: VisitMethod;
  /** Sent as JSON — or as multipart when it is a `FormData` (file uploads, with `onProgress`). For `get`, as query string. */
  data?: Record<string, unknown> | FormData;
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Keep the scroll position — of the window and of every `scroll-region` (default: back to the top on a new page). */
  preserveScroll?: boolean;
  /**
   * Keep component state (form input, open panels) when the same page component
   * comes back. Default: true for non-GET visits — a form that failed validation
   * keeps what was typed — false for GET visits.
   */
  preserveState?: boolean;
  headers?: Record<string, string>;
  /**
   * A partial reload (E7): the server sends only these props of the current page — and computes only them — and
   * they are merged into the props the page has. Applies when the response is the same page component; any other
   * page comes in full. Props the controller marked `always()` (the shared `errors`) come anyway.
   */
  only?: readonly string[];
  /** A partial reload of every prop but these (`optional()`/`defer()` props still only by name, with `only`). */
  except?: readonly string[];
  /** Props to replace instead of merge, though the server marked them `merge()` (start a list over). */
  reset?: readonly string[];
  /**
   * In the background (a poll, "load more" as you scroll): no progress bar, it does not cancel the visit under way
   * and a newer visit does not cancel it. It lands only on the page it started from — moved on meanwhile, the
   * answer is dropped.
   */
  async?: boolean;
  /**
   * Keep the URL of the page on screen, though the request went elsewhere — "load more" with `data: { cursor }`:
   * the history entry stays the list's URL (replaced, not a new one), so a reload starts it over instead of showing
   * one later page alone.
   */
  preserveUrl?: boolean;
}

/** A prefetch: always a GET (`data` goes into the query string). */
export interface PrefetchOptions {
  /** How long the prefetched page may be shown instead of asking the server, in ms (default 30 000). */
  cacheFor?: number;
  data?: Record<string, unknown>;
}

/** How long a prefetched page is used by default: 30 s, like Inertia. */
export const DEFAULT_PREFETCH_CACHE_FOR = 30_000;

/** Prefetched pages kept at most (the oldest goes first). */
const PREFETCH_LIMIT = 30;

export interface ScrollPosition {
  readonly x: number;
  readonly y: number;
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
  readonly scroll: ScrollPosition;
  /** The positions of the page's `scroll-region` elements, in document order. */
  readonly regions?: readonly ScrollPosition[];
  /** The entry's page in the in-memory cache — random, so entries of an earlier document never match. */
  readonly key: string;
}

export function isHistoryState(value: unknown): value is HistoryState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.key === 'string' && typeof state.url === 'string' && typeof state.component === 'string' && !('props' in state);
}

/** The attribute that marks a scrolling container whose position Back/Forward restores, like the window's. */
export const SCROLL_REGION_ATTRIBUTE = 'scroll-region';

/** An element that scrolls (a `scroll-region`). */
export interface ScrollRegion {
  scrollLeft: number;
  scrollTop: number;
}

type WindowEvent = 'popstate' | 'pageshow' | 'scroll';

/** The parts of `window` the navigator uses (a fake one in tests). The optional ones only add features. */
export interface NavigatorWindow {
  readonly history: Pick<History, 'state' | 'pushState' | 'replaceState'> & { scrollRestoration?: ScrollRestoration };
  readonly location: Pick<Location, 'href' | 'origin' | 'pathname' | 'search' | 'assign' | 'replace' | 'reload'>;
  readonly scrollX: number;
  readonly scrollY: number;
  scrollTo(x: number, y: number): void;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  addEventListener(type: WindowEvent, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: WindowEvent, listener: (event: Event) => void, options?: EventListenerOptions): void;
  /** For `scroll-region` elements and `#fragment` targets. */
  readonly document?: { querySelectorAll(selectors: string): Iterable<ScrollRegion>; getElementById(id: string): { scrollIntoView(): void } | null };
  /** For the upload progress of `FormData` visits — `fetch` cannot report it (over HTTP/1.1). */
  readonly XMLHttpRequest?: new () => XMLHttpRequest;
}

export interface NavigatorOptions {
  /** The page the server rendered (from `#bespoke-page`) — always fresh: a full load asks the server. */
  initialPage: PageObject;
  /** Shows a page: resolve its component and render it. Resolves once it is on screen (scroll restores after that). */
  render: (page: PageObject, options: { preserveState: boolean }) => Promise<void>;
  /** Default: the browser's `window`. */
  window?: NavigatorWindow;
  /** Pages kept in memory, one per history entry; the least recently shown goes first. Default 20. */
  cacheSize?: number;
}

/** How many pages the in-memory cache keeps by default. */
export const DEFAULT_PAGE_CACHE_SIZE = 20;

/** Scroll positions are written to the history entry this long after scrolling stops (browsers limit `replaceState` calls). */
const SCROLL_SAVE_DELAY = 100;

interface Scroll {
  scroll: ScrollPosition;
  regions: ScrollPosition[];
}

const TOP: Scroll = { scroll: { x: 0, y: 0 }, regions: [] };

/**
 * Navigates without full page loads: a visit fetches the next page object as JSON (`x-bespoke`), keeps it
 * in memory and pushes a history entry *without* its props. Back and Forward show the page from memory —
 * or ask the server when it is not there — and restore where it was scrolled to. A `409` with
 * `x-bespoke-location` (a new build, or signing in or out — `ClientHistory` on the server) loads that URL
 * fully and drops every page kept in memory. Every request reports its events (`on('start', …)`).
 */
export class Navigator {
  readonly #window: NavigatorWindow;
  readonly #render: NavigatorOptions['render'];
  readonly #cache: PageCache;
  /** Scroll positions by history key — exact to the last scroll event, unlike the (debounced) history entry. */
  readonly #positions = new BoundedMap<string, Scroll>(100);
  readonly #listeners: { [E in VisitEvent]: Set<VisitEvents[E]> } = {
    start: new Set(),
    progress: new Set(),
    success: new Set(),
    error: new Set(),
    exception: new Set(),
    cancel: new Set(),
    finish: new Set(),
  };
  /** The asset version this tab runs — the one of the page it was loaded with. */
  readonly #version: string | null;
  #page: PageObject;
  #key: string | undefined;
  #inFlight: AbortController | undefined;
  /** Deferred props being loaded — `<history key> <group>`, so no group is asked for twice at once. */
  readonly #loading = new Set<string>();
  /** Requests in the background (`visit.async`): they die with the document's pages when it is left. */
  readonly #background = new Set<AbortController>();
  /**
   * Prefetched pages by URL — in memory only, like every page (E36): never in `history.state` or any storage. Used
   * once, by the visit they were fetched for, within their `cacheFor`; dropped when the document is left (signing
   * out) and when a non-GET visit changes what they show.
   */
  readonly #prefetched = new BoundedMap<string, Prefetched>(PREFETCH_LIMIT);
  /** Who follows the page on screen (`subscribe`) — query state, say. */
  readonly #pageListeners = new Set<(page: PageObject) => void>();
  /** This document was left for a full page load (409, a response that is not a page). */
  #left = false;
  /** A page is being swapped in: scroll events belong to no entry until its position is set. */
  #transitioning = false;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;

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

  /**
   * Takes over the history (Back/Forward, scroll restoration, the back/forward cache). Returns the function
   * that stops it.
   */
  start(): () => void {
    const restored = this.#adopt();
    // The navigator restores scroll positions itself — the browser's would apply before the page is rendered.
    if (this.#window.history.scrollRestoration !== undefined) this.#window.history.scrollRestoration = 'manual';
    // A reload or a session restore keeps the entry: back to where it was.
    if (restored) this.#applyScroll(this.#positionOf(restored));
    // The first render is on screen — now the props it was sent without.
    this.#loadDeferred();
    this.#window.addEventListener('popstate', this.#onPopState);
    this.#window.addEventListener('pageshow', this.#onPageShow);
    // Capturing: scroll events of elements do not bubble, but pass the window on their way down.
    this.#window.addEventListener('scroll', this.#onScroll, { capture: true, passive: true });
    return () => {
      this.#window.removeEventListener('popstate', this.#onPopState);
      this.#window.removeEventListener('pageshow', this.#onPageShow);
      this.#window.removeEventListener('scroll', this.#onScroll, { capture: true });
      clearTimeout(this.#saveTimer);
    };
  }

  /**
   * Follows the page on screen: `listener` runs whenever it changes — a visit landed, Back/Forward, props merged in.
   * Returns the function that stops it.
   */
  subscribe(listener: (page: PageObject) => void): () => void {
    this.#pageListeners.add(listener);
    return () => void this.#pageListeners.delete(listener);
  }

  /**
   * Typed URL state of the page on screen (E55): its query, parsed by the server (`PageObject.query`), changed with
   * visits of the same page — debounced, partial, keeping state and scroll. See {@link QueryState}.
   */
  queryState<Q extends Record<string, unknown> = Record<string, unknown>>(options: QueryStateOptions = {}): QueryState<Q> {
    return new QueryState<Q>(this, options);
  }

  /** Listens to the events of every request (a progress bar, logging). Returns the function that stops listening. */
  on<E extends VisitEvent>(event: E, listener: VisitEvents[E]): () => void {
    const listeners = this.#listeners[event] as Set<VisitEvents[E]>;
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }

  /**
   * Resolves with the page the visit ended on — undefined if it did not end on a page: the browser took over,
   * a newer visit replaced it (`onCancel`), or it failed (`onException`). It never rejects for a failed request.
   */
  async visit(url: string, options: VisitOptions = {}): Promise<PageObject | undefined> {
    this.#adopt();
    const { method = 'get', data, replace = false, preserveScroll = false, headers = {}, async: background = false, preserveUrl = false } = options;
    const preserveState = options.preserveState ?? method !== 'get';

    const target = new URL(url, this.#window.location.href);
    if (target.origin !== this.#window.location.origin) {
      // Another site: the browser goes there. Visits only ever read answers of this one.
      this.#leave();
      this.#window.location.assign(target.href);
      return undefined;
    }
    // A form changes what prefetched pages show: none of them is used after it.
    if (method !== 'get') this.#flushPrefetched();

    const request = buildRequest(target, method, data);
    // A partial reload names the page it reloads: the server sends only some props when it renders that one.
    const partial = options.only !== undefined || (options.except?.length ?? 0) > 0 ? this.#page.component : undefined;
    const partialHeaders = partial === undefined ? {} : partialReloadHeaders(partial, options.only, options.except);
    // A plain GET visit of a prefetched URL takes that page (or waits for its request, still under way).
    const prefetched = method === 'get' && partial === undefined && Object.keys(headers).length === 0 ? this.#takePrefetched(request.url) : undefined;
    const visit: Visit = background ? { url: request.url, method, async: true } : { url: request.url, method };
    // An async visit lands only on the page it started from.
    const from = this.#key;
    return this.#request(visit, options, async (signal, onProgress) => {
      let page = prefetched ? await untilAborted(prefetched, signal) : undefined;
      if (!page) {
        if (signal.aborted) return undefined;
        const response = await this.#send(
          request.url,
          { method, headers: { ...request.headers, ...partialHeaders, ...headers }, body: request.body, signal },
          onProgress,
        );
        page = await this.#read(response, { replace, failed: true }, visit, options);
      }
      if (!page || signal.aborted) return undefined;
      if (background && (this.#left || this.#key !== from || this.#transitioning)) return undefined;
      // Some props of the same page: into the ones it has. (Another page — a redirect to the login — came in full.)
      if (partial !== undefined && page.component === partial && this.#page.component === partial) page = mergePage(this.#page, page, options.reset);
      // The URL — and so the query state — stays the one of the page on screen.
      if (preserveUrl) page = withQueryOf({ ...page, url: this.#page.url }, this.#page);
      // Redirected back to the same URL (a failed form), or kept the URL ("load more"): replace, don't stack history entries.
      const sameUrl = page.url === this.#window.location.pathname + this.#window.location.search;
      const history = replace || preserveUrl || (method !== 'get' && sameUrl) ? 'replace' : 'push';
      const shown = await this.#show(page, history, { preserveScroll, preserveState, hash: preserveUrl ? '' : target.hash });
      if (shown) {
        const errors = validationErrors(shown);
        if (errors) this.#emit('error', options.onError, errors, visit);
        else this.#emit('success', options.onSuccess, shown, visit);
      }
      return shown;
    });
  }

  /**
   * Fetches a page ahead of the visit (a hovered link): GET only, with `Purpose: prefetch`, so the server can tell
   * and leave out side effects. A visit of the same URL within `cacheFor` shows it without asking again — or
   * waits for it, if it is still under way. No events, no progress bar, no fallback: a prefetch that fails (offline,
   * 5xx, a 409 after a deployment, anything but a page) is forgotten, and the visit asks the server itself.
   */
  prefetch(url: string, options: PrefetchOptions = {}): Promise<void> {
    // Never anything but a GET — whatever a caller passes (a form, an action, is no page to fetch ahead).
    const method = (options as { method?: unknown }).method;
    if (this.#left || (method !== undefined && String(method).toLowerCase() !== 'get')) return Promise.resolve();
    this.#adopt();
    const target = new URL(url, this.#window.location.href);
    if (target.origin !== this.#window.location.origin) return Promise.resolve();
    const { url: key } = buildRequest(target, 'get', options.data);
    if (key === this.#page.url) return Promise.resolve();
    const existing = this.#prefetched.peek(key);
    if (existing && !existing.expired()) return existing.page.then(() => undefined);

    const cacheFor = options.cacheFor ?? DEFAULT_PREFETCH_CACHE_FOR;
    const controller = new AbortController();
    const entry: Prefetched = {
      controller,
      page: this.#fetchAhead(key, controller.signal).then((page) => {
        // Kept from when it arrived; nothing to keep → the visit asks the server.
        if (page && this.#prefetched.peek(key) === entry) entry.expiresAt = Date.now() + cacheFor;
        else if (this.#prefetched.peek(key) === entry) this.#prefetched.delete(key);
        return page;
      }),
      expiresAt: Infinity,
      expired: () => Date.now() >= entry.expiresAt,
    };
    this.#prefetched.set(key, entry);
    return entry.page.then(() => undefined);
  }

  /** The page of a prefetch — undefined for anything that is not a page to show as it is. */
  async #fetchAhead(url: string, signal: AbortSignal): Promise<PageObject | undefined> {
    try {
      const response = await this.#send(url, { method: 'get', headers: { [PURPOSE_HEADER]: 'prefetch' }, signal });
      // 409 (a new build, signing in or out), 5xx, a 4xx page, not a page: the visit asks again and handles it.
      if (!response.ok || response.headers.get(PAGE_HEADER) !== 'true') {
        await response.body?.cancel();
        return undefined;
      }
      const page = (await response.json()) as PageObject;
      return this.#left || signal.aborted ? undefined : page;
    } catch {
      return undefined;
    }
  }

  /** The prefetched page of `url`, if it may still be used — taken: a later visit asks the server again. */
  #takePrefetched(url: string): Promise<PageObject | undefined> | undefined {
    const entry = this.#prefetched.peek(url);
    if (!entry) return undefined;
    this.#prefetched.delete(url);
    return entry.expired() ? undefined : entry.page;
  }

  #flushPrefetched(): void {
    for (const entry of this.#prefetched.values()) entry.controller.abort();
    this.#prefetched.clear();
  }

  /** How many prefetched pages are kept (tests). */
  get prefetchedPages(): number {
    return this.#prefetched.size;
  }

  /**
   * The current page again from the server (fresh props), keeping scroll position and component state. `data`
   * goes into the query string — `reload({ data: { cursor }, only: ['people'], preserveUrl: true })` loads more.
   */
  reload(options: Omit<VisitOptions, 'method'> = {}): Promise<PageObject | undefined> {
    const { pathname, search } = this.#window.location;
    return this.visit(pathname + search, { replace: true, preserveScroll: true, preserveState: true, ...options });
  }

  /** The entry the document was loaded into gets a key, and its page goes into the cache. Returns a restored entry. */
  #adopt(): HistoryState | undefined {
    if (this.#key !== undefined) return undefined;
    const state: unknown = this.#window.history.state;
    // A reload or session restore keeps the entry's key (and scroll); the page itself came fresh from the server.
    const restored = isHistoryState(state) ? state : undefined;
    this.#key = restored?.key ?? newKey();
    this.#cache.set(this.#key, this.#page);
    this.#window.history.replaceState(entry(this.#page, this.#key, restored ? this.#positionOf(restored) : TOP), '', this.#window.location.href);
    return restored;
  }

  async #show(
    page: PageObject,
    history: 'push' | 'replace',
    { preserveScroll, preserveState, hash }: { preserveScroll: boolean; preserveState: boolean; hash: string },
  ): Promise<PageObject | undefined> {
    const leaving = this.#currentScroll();
    this.#cancelScrollSave();
    this.#transitioning = true;
    try {
      try {
        await this.#render(page, { preserveState });
      } catch {
        // The page's code could not be loaded (a chunk gone after a deployment, offline): the browser loads it.
        this.#leave();
        this.#window.location.assign(page.url);
        return undefined;
      }
      const { history: browserHistory } = this.#window;
      const arrived = preserveScroll ? this.#currentScroll() : TOP;
      if (history === 'push') {
        // Remember where the page being left was scrolled to — Back restores it.
        this.#positions.set(this.#key!, leaving);
        browserHistory.replaceState(entry(this.#page, this.#key!, leaving), '', this.#window.location.href);
        this.#key = newKey();
        browserHistory.pushState(entry(page, this.#key, arrived), '', page.url + hash);
      } else {
        browserHistory.replaceState(entry(page, this.#key!, arrived), '', page.url + hash);
      }
      this.#positions.set(this.#key!, arrived);
      this.#cache.set(this.#key!, page);
      this.#setPage(page);
      if (!preserveScroll) this.#applyScroll(TOP);
      if (hash) this.#window.document?.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
      this.#loadDeferred();
      return page;
    } finally {
      this.#transitioning = false;
    }
  }

  readonly #onPopState = (event: Event): void => {
    const state: unknown = (event as PopStateEvent).state;
    // `null`: an entry of a fragment link (`#section`) on the same page.
    if (state === null || state === undefined) return;
    this.#inFlight?.abort();
    // A save still pending belongs to the entry just left; the browser already switched to the new one.
    this.#cancelScrollSave();
    if (isHistoryState(state)) {
      const cached = this.#cache.get(state.key);
      if (cached) {
        this.#key = state.key;
        this.#setPage(cached);
        void this.#arrive(cached, this.#positionOf(state));
        return;
      }
      void this.#restore(state.url, state.key, this.#positionOf(state));
      return;
    }
    // An entry of an older client, which kept whole pages in the history: never shown — the server is asked.
    if (isPageObject(state)) void this.#restore(state.url, newKey(), TOP);
  };

  /** Renders a page of the history and scrolls to where it was. */
  async #arrive(page: PageObject, position: Scroll): Promise<void> {
    this.#transitioning = true;
    try {
      await this.#render(page, { preserveState: false });
      this.#applyScroll(position);
      this.#loadDeferred();
    } catch {
      this.#leave();
      this.#window.location.reload();
    } finally {
      this.#transitioning = false;
    }
  }

  /** Back/Forward to an entry whose page is not in memory: the server decides what it shows now. */
  async #restore(url: string, key: string, position: Scroll): Promise<void> {
    const visit: Visit = { url, method: 'get' };
    await this.#request(visit, {}, async (signal) => {
      let response: Response;
      try {
        response = await this.#send(url, { method: 'get', headers: {}, signal });
      } catch (error) {
        if (signal.aborted) throw error;
        // The server cannot be asked (offline): let the browser load the entry itself.
        this.#leave();
        this.#window.location.reload();
        return undefined;
      }
      // An error page is what this URL shows now — like a full load would.
      const page = await this.#read(response, { replace: true, failed: false }, visit, {});
      if (!page || signal.aborted) return undefined;
      // Signed out meanwhile? Then the server sent the login page — and the entry is the login page now.
      this.#window.history.replaceState(entry(page, key, position), '', page.url);
      this.#key = key;
      this.#cache.set(key, page);
      this.#setPage(page);
      await this.#arrive(page, position);
      return page;
    });
  }

  readonly #onPageShow = (event: Event): void => {
    // Back into this document from the back/forward cache, after it was left for a full page load (signing
    // out, say): what it still shows may not be for whoever is here now. Ask the server.
    if ((event as PageTransitionEvent).persisted && this.#left) this.#window.location.reload();
  };

  /**
   * Loads the deferred props of the page on screen (`deferredProps`): one partial reload per group, in parallel, in
   * the background. Each one lands in the page it was loaded for — on screen, or in memory if it was left meanwhile.
   */
  #loadDeferred(): void {
    const page = this.#page;
    const key = this.#key;
    if (!page.deferredProps || key === undefined) return;
    for (const [group, props] of Object.entries(page.deferredProps)) {
      const id = `${key} ${group}`;
      if (props.length === 0 || this.#loading.has(id)) continue;
      this.#loading.add(id);
      void this.#loadGroup(key, page, props).finally(() => this.#loading.delete(id));
    }
  }

  async #loadGroup(key: string, page: PageObject, props: readonly string[]): Promise<void> {
    const visit: Visit = { url: page.url, method: 'get', async: true };
    await this.#request(visit, {}, async (signal) => {
      const response = await this.#send(page.url, { method: 'get', headers: partialReloadHeaders(page.component, props, undefined), signal });
      const loaded = await this.#read(response, { replace: true, failed: true }, visit, {});
      // Another page (signed out meanwhile: the login page) is not what was asked for — the fallback stays.
      if (!loaded || loaded.component !== page.component) return undefined;
      // Only the group's props: what comes `always` (the shared errors) belongs to the request that showed the page.
      const only = { ...loaded, props: Object.fromEntries(props.filter((prop) => Object.hasOwn(loaded.props, prop)).map((prop) => [prop, loaded.props[prop]])) };
      return this.#land(key, page, only);
    });
  }

  /** Merges loaded props into the page of history entry `key` — and shows it, if that is the page on screen. */
  async #land(key: string, page: PageObject, loaded: PageObject): Promise<PageObject | undefined> {
    // Left for a full page load (signed out, say): nothing lands in what this document shows any more.
    if (this.#left) return undefined;
    const onScreen = this.#key === key && !this.#transitioning;
    const target = onScreen ? this.#page : this.#cache.peek(key);
    // The entry shows another URL now (a replacing visit): these props are not for it.
    if (!target || target.url !== page.url || target.component !== page.component) return undefined;
    const merged = mergePage(target, loaded);
    this.#cache.update(key, merged);
    if (onScreen) {
      this.#setPage(merged);
      await this.#render(merged, { preserveState: true });
    }
    return merged;
  }

  /**
   * One request with its events. A newer request always wins over a slower, older one (it aborts it — the
   * older one is cancelled); requests in the background (`visit.async`) run beside them. Failures become
   * `exception` events, never rejections.
   */
  async #request(
    visit: Visit,
    callbacks: VisitCallbacks,
    task: (signal: AbortSignal, onProgress: (progress: VisitProgress) => void) => Promise<PageObject | undefined>,
  ): Promise<PageObject | undefined> {
    const controller = new AbortController();
    if (visit.async) {
      this.#background.add(controller);
    } else {
      this.#inFlight?.abort();
      this.#inFlight = controller;
    }
    this.#emit('start', callbacks.onStart, visit);
    try {
      const page = await task(controller.signal, (progress) => this.#emit('progress', callbacks.onProgress, progress, visit));
      if (controller.signal.aborted) this.#emit('cancel', callbacks.onCancel, visit);
      return page;
    } catch (cause) {
      if (controller.signal.aborted) this.#emit('cancel', callbacks.onCancel, visit);
      else this.#emit('exception', callbacks.onException, { type: 'network', visit, cause });
      return undefined;
    } finally {
      if (this.#inFlight === controller) this.#inFlight = undefined;
      this.#background.delete(controller);
      this.#emit('finish', callbacks.onFinish, visit);
    }
  }

  /**
   * The page object of a response — or undefined when there is none to show: a full page load took over
   * (409, a response that is not a page), or the server failed (5xx, reported as an `error` when `failed`).
   */
  async #read(response: Response, { replace, failed }: { replace: boolean; failed: boolean }, visit: Visit, callbacks: VisitCallbacks): Promise<PageObject | undefined> {
    const location = response.status === 409 ? response.headers.get(LOCATION_HEADER) : null;
    if (location) {
      // A new build, or signing in or out: load the page fully. The pages in memory go with this document.
      this.#leave();
      if (replace) this.#window.location.replace(location);
      else this.#window.location.assign(location);
      return undefined;
    }
    const isPage = response.headers.get(PAGE_HEADER) === 'true';
    if (failed && response.status >= 500) {
      // The page stays (and whatever was typed into it); the app shows the server's error as a fallback.
      const page = isPage ? ((await response.json()) as PageObject) : undefined;
      const html = isPage ? undefined : await response.text();
      this.#emit('exception', callbacks.onException, { type: 'server', visit, status: response.status, page, html });
      return undefined;
    }
    if (!isPage) {
      // Not a page (e.g. a 401 JSON or a file download): let the browser handle it.
      this.#leave();
      this.#window.location.assign(response.url || new URL(visit.url, this.#window.location.href).href);
      return undefined;
    }
    return (await response.json()) as PageObject;
  }

  /** Sends a request with the page headers — through XHR for `FormData` with a progress listener (upload progress). */
  #send(
    url: string,
    { method, headers, body, signal }: { method: VisitMethod; headers: Record<string, string>; body?: BodyInit; signal: AbortSignal },
    onProgress?: (progress: VisitProgress) => void,
  ): Promise<Response> {
    const init = {
      method: method.toUpperCase(),
      headers: { [PAGE_HEADER]: 'true', ...(this.#version ? { [VERSION_HEADER]: this.#version } : {}), ...headers },
      body,
      signal,
    };
    const Xhr = this.#window.XMLHttpRequest;
    if (body instanceof FormData && onProgress && Xhr) return sendWithProgress(Xhr, url, init, onProgress);
    return this.#window.fetch(url, init);
  }

  #emit<E extends VisitEvent>(event: E, callback: VisitEvents[E] | undefined, ...args: Parameters<VisitEvents[E]>): void {
    const call = (listener: VisitEvents[E]) => {
      try {
        (listener as (...args: Parameters<VisitEvents[E]>) => void)(...args);
      } catch (error) {
        // A listener's bug must not break the navigation (nor the other listeners).
        queueMicrotask(() => {
          throw error;
        });
      }
    };
    if (callback) call(callback);
    for (const listener of this.#listeners[event] as Set<VisitEvents[E]>) call(listener);
  }

  readonly #onScroll = (): void => {
    if (this.#transitioning || this.#key === undefined) return;
    this.#positions.set(this.#key, this.#currentScroll());
    this.#cancelScrollSave();
    // Into the entry too, for a reload or a session restore — debounced: browsers throttle replaceState.
    this.#saveTimer = setTimeout(() => {
      const key = this.#key;
      const state: unknown = this.#window.history.state;
      if (this.#transitioning || key === undefined || !isHistoryState(state) || state.key !== key) return;
      const position = this.#positions.get(key);
      if (position) this.#window.history.replaceState(withPosition(state, position), '', this.#window.location.href);
    }, SCROLL_SAVE_DELAY);
  };

  #cancelScrollSave(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
  }

  /** Where an entry was scrolled to: from memory (exact), else from the entry itself. */
  #positionOf(state: HistoryState): Scroll {
    return this.#positions.get(state.key) ?? { scroll: state.scroll ?? TOP.scroll, regions: [...(state.regions ?? [])] };
  }

  #regions(): ScrollRegion[] {
    return this.#window.document ? [...this.#window.document.querySelectorAll(`[${SCROLL_REGION_ATTRIBUTE}]`)] : [];
  }

  #currentScroll(): Scroll {
    return {
      scroll: { x: this.#window.scrollX, y: this.#window.scrollY },
      regions: this.#regions().map((region) => ({ x: region.scrollLeft, y: region.scrollTop })),
    };
  }

  #applyScroll({ scroll, regions }: Scroll): void {
    this.#window.scrollTo(scroll.x, scroll.y);
    this.#regions().forEach((region, index) => {
      const position = regions[index] ?? TOP.scroll;
      region.scrollLeft = position.x;
      region.scrollTop = position.y;
    });
  }

  #setPage(page: PageObject): void {
    this.#page = page;
    for (const listener of this.#pageListeners) {
      try {
        listener(page);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  /** Before a full page load: nothing kept in memory survives it, should the browser bring this document back. */
  #leave(): void {
    this.#left = true;
    this.#cache.clear();
    // Prefetched while signed in: not for whoever comes next — and one still under way lands nowhere.
    this.#flushPrefetched();
    // A deferred prop still loading must not come back into a page of someone who has left (signed out).
    for (const request of this.#background) request.abort();
  }
}

/** `page` with the query of `from` (or without one, when `from` has none). */
function withQueryOf(page: PageObject, from: PageObject): PageObject {
  const { query: _query, queryDefaults: _defaults, ...rest } = page;
  return {
    ...rest,
    ...(from.query ? { query: from.query } : {}),
    ...(from.queryDefaults ? { queryDefaults: from.queryDefaults } : {}),
  };
}

/** The headers of a partial reload of `component`. */
function partialReloadHeaders(component: string, only: readonly string[] | undefined, except: readonly string[] | undefined): Record<string, string> {
  return {
    [PARTIAL_COMPONENT_HEADER]: component,
    ...(only === undefined ? {} : { [PARTIAL_DATA_HEADER]: only.join(',') }),
    ...(except && except.length > 0 ? { [PARTIAL_EXCEPT_HEADER]: except.join(',') } : {}),
  };
}

/**
 * The page after a partial reload: the props it had, with the new ones — merged where the server marked them
 * (`mergeProps`: arrays appended, objects merged one level; `deepMergeProps`: all the way down), unless `reset`.
 * Deferred props that arrived are no longer pending.
 */
export function mergePage(current: PageObject, partial: PageObject, reset: readonly string[] = []): PageObject {
  const props: Record<string, unknown> = { ...current.props };
  const match = partial.matchPropsOn ?? [];
  for (const [key, value] of Object.entries(partial.props)) {
    if (reset.includes(key)) props[key] = value;
    else if (partial.mergeProps?.includes(key)) props[key] = mergeValues(props[key], value, false, key, match);
    else if (partial.deepMergeProps?.includes(key)) props[key] = mergeValues(props[key], value, true, key, match);
    else props[key] = value;
  }
  const { deferredProps: _pending, mergeProps: _merge, deepMergeProps: _deep, matchPropsOn: _match, ...rest } = partial;
  const deferredProps = stillPending(current.deferredProps, Object.keys(partial.props));
  const mergeProps = union(current.mergeProps, partial.mergeProps);
  const deepMergeProps = union(current.deepMergeProps, partial.deepMergeProps);
  const matchPropsOn = union(current.matchPropsOn, partial.matchPropsOn);
  return {
    ...rest,
    props,
    ...(deferredProps ? { deferredProps } : {}),
    ...(mergeProps ? { mergeProps } : {}),
    ...(deepMergeProps ? { deepMergeProps } : {}),
    ...(matchPropsOn ? { matchPropsOn } : {}),
  };
}

/** Merges `next` into `current`, at `path` of the props (`others.data`) — arrays by the key `matchPropsOn` names for the path. */
function mergeValues(current: unknown, next: unknown, deep: boolean, path: string, match: readonly string[]): unknown {
  if (Array.isArray(current) && Array.isArray(next)) return append(current, next, matchKey(path, match));
  if (isPlainObject(current) && isPlainObject(next)) {
    if (!deep) return { ...current, ...next };
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(next)) merged[key] = Object.hasOwn(current, key) ? mergeValues(current[key], value, true, `${path}.${key}`, match) : value;
    return merged;
  }
  return next;
}

/** The key that identifies the items of the array at `path` — `matchPropsOn: ['others.data.id']` → `id` for `others.data`. */
function matchKey(path: string, match: readonly string[]): string | undefined {
  const prefix = `${path}.`;
  return match.find((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('.'))?.slice(prefix.length);
}

/**
 * `next` after `current` — with a `key`, an item whose key is shown already takes that one's place (the same page
 * loaded twice: a poll, "load more" clicked twice) instead of appearing again.
 */
function append(current: readonly unknown[], next: readonly unknown[], key: string | undefined): unknown[] {
  if (key === undefined) return [...current, ...next];
  const merged = [...current];
  const at = new Map<unknown, number>();
  merged.forEach((item, index) => {
    if (isPlainObject(item) && item[key] !== undefined) at.set(item[key], index);
  });
  for (const item of next) {
    const id = isPlainObject(item) ? item[key] : undefined;
    const index = id === undefined ? undefined : at.get(id);
    if (index !== undefined) {
      merged[index] = item;
    } else {
      if (id !== undefined) at.set(id, merged.length);
      merged.push(item);
    }
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stillPending(groups: PageObject['deferredProps'], arrived: readonly string[]): PageObject['deferredProps'] {
  if (!groups) return undefined;
  const pending = Object.entries(groups)
    .map(([group, props]) => [group, props.filter((prop) => !arrived.includes(prop))] as const)
    .filter(([, props]) => props.length > 0);
  return pending.length > 0 ? Object.fromEntries(pending) : undefined;
}

function union(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] | undefined {
  if (!a && !b) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/** The validation errors a page carries (the shared `errors` prop), or undefined when there are none. */
function validationErrors(page: PageObject): ValidationErrors | undefined {
  const errors = (page.props as { errors?: unknown }).errors;
  return typeof errors === 'object' && errors !== null && Object.keys(errors).length > 0 ? (errors as ValidationErrors) : undefined;
}

function entry(page: PageObject, key: string, position: Scroll): HistoryState {
  return withPosition({ component: page.component, url: page.url, key, scroll: position.scroll }, position);
}

/** The state with the position — `regions` only when the page has any. */
function withPosition(state: HistoryState, { scroll, regions }: Scroll): HistoryState {
  const { regions: _old, ...rest } = state;
  return regions.length > 0 ? { ...rest, scroll, regions } : { ...rest, scroll };
}

function newKey(): string {
  // Not crypto.randomUUID(): that exists only in secure contexts (not on http://192.168.…).
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A Map that forgets its oldest entries beyond `size`. */
class BoundedMap<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #size: number;

  constructor(size: number) {
    this.#size = Math.max(1, size);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#size) break;
      this.#entries.delete(oldest);
    }
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }

  /** The entry without counting it as used. */
  peek(key: K): V | undefined {
    return this.#entries.get(key);
  }

  /** Replaces an entry that is there, keeping its place. */
  update(key: K, value: V): void {
    if (this.#entries.has(key)) this.#entries.set(key, value);
  }

  clear(): void {
    this.#entries.clear();
  }

  values(): IterableIterator<V> {
    return this.#entries.values();
  }
}

/** A prefetched page: its request (under way or done), and until when it may be shown. */
interface Prefetched {
  readonly controller: AbortController;
  readonly page: Promise<PageObject | undefined>;
  expiresAt: number;
  expired(): boolean;
}

/** `promise`, or undefined as soon as `signal` aborts — a newer visit does not wait for a prefetch it does not need. */
function untilAborted<T>(promise: Promise<T | undefined>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    });
  });
}

/** Page objects by history key, least recently used first out. */
class PageCache extends BoundedMap<string, PageObject> {
  override get(key: string): PageObject | undefined {
    const page = super.get(key);
    if (page) this.set(key, page);
    return page;
  }
}

/**
 * XHR, because `fetch` reports no upload progress (streaming request bodies need HTTP/2 in Chromium, and
 * a `FormData` body would have to be streamed by hand). Answers with a `Response` like `fetch`.
 */
function sendWithProgress(
  Xhr: new () => XMLHttpRequest,
  url: string,
  { method, headers, body, signal }: { method: string; headers: Record<string, string>; body?: BodyInit; signal: AbortSignal },
  onProgress: (progress: VisitProgress) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new Xhr();
    xhr.open(method, url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener('progress', (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : undefined;
      onProgress({ loaded: event.loaded, total, percentage: total === undefined ? undefined : Math.round((event.loaded / total) * 100) });
    });
    xhr.addEventListener('load', () => {
      const responseHeaders = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const colon = line.indexOf(':');
        if (colon > 0) responseHeaders.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
      const empty = [101, 204, 205, 304].includes(xhr.status);
      const response = new Response(empty ? null : xhr.responseText, { status: xhr.status, statusText: xhr.statusText, headers: responseHeaders });
      Object.defineProperty(response, 'url', { value: xhr.responseURL });
      resolve(response);
    });
    xhr.addEventListener('error', () => reject(new TypeError('Network request failed')));
    xhr.addEventListener('abort', () => reject(new DOMException('The visit was aborted.', 'AbortError')));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body as XMLHttpRequestBodyInit);
  });
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
    return { url: target.pathname + target.search, headers: {} };
  }
  const url = target.pathname + target.search;
  const token = xsrfToken();
  const headers: Record<string, string> = token ? { 'x-xsrf-token': token } : {};
  // Multipart for files — the browser sets the boundary.
  if (data instanceof FormData) return { url, headers, body: data };
  if (data && hasFiles(data)) return { url, headers, body: toFormData(data) };
  return { url, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) };
}

function hasFiles(value: unknown): boolean {
  if (value instanceof Blob) return true;
  if (Array.isArray(value)) return value.some(hasFiles);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(hasFiles);
  return false;
}

/**
 * Data with a file in it, as multipart: nested keys in brackets (`links[0][url]`), the notation the server
 * parses back into objects. As in any HTML form, other values become strings — `true` is `1`, `false` is `0`,
 * `null` is empty.
 */
function toFormData(data: Record<string, unknown>, form = new FormData(), prefix = ''): FormData {
  for (const [key, value] of Object.entries(data)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined) continue;
    if (value instanceof Blob) form.append(name, value);
    else if (Array.isArray(value)) toFormData(Object.fromEntries(value.map((item, index) => [String(index), item])), form, name);
    else if (typeof value === 'object' && value !== null) toFormData(value as Record<string, unknown>, form, name);
    else form.append(name, value === null ? '' : typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  return form;
}

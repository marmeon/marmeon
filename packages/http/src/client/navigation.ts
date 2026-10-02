/**
 * The heart of the UI-free client core (`@bespokecore/http/client`): visits and their events, the browser history,
 * the in-memory page cache (E36), partial reloads, deferred and merged props, prefetching and scroll restoration.
 * No UI framework in here — an adapter (`<BespokeApp>` of @bespokecore/react) renders what the navigator hands it.
 */
import {
  isPageObject,
  LAYER_BACKDROP,
  LAYER_CLOSE_HEADER,
  LOCATION_HEADER,
  MAX_LAYER_DEPTH,
  PAGE_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PURPOSE_HEADER,
  REGION_HEADER,
  REGION_STATUS_HEADER,
  VERSION_HEADER,
  type DeferredResult,
  type LayerClose,
  type PageObject,
  type RegionObject,
  type ValidationErrors,
} from '../page.ts';
import { mergePage } from './merge.ts';
import { Actions, applyPatches, rollBack, Submissions, type ActionOptions, type ActionOutcome, type Submission } from './action.ts';
import { Layer, type LayerControl, type LayerHost } from './layer.ts';
import { PatchQueue, Revalidations, type OptimisticUpdate, type PatchTarget, type PropsPatch, type Reloading, type ReloadSpec } from './optimistic.ts';
import { QueryState, type QueryStateOptions } from './query-state.ts';
import { RegionOwner, type KeptRegion, type Region, type RegionInitial, type RegionResponse, type RegionTransport } from './region.ts';

export { mergePage } from './merge.ts';

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
   * Open the answer as a layer (E53) — `<Link layer>`: sent as a layer's request (`x-bespoke-region: layer`). An answer
   * that is a layer opens over what is on screen whatever this says; one that is a page is shown as the page.
   */
  layer?: boolean;
  /**
   * Patches shown while the visit is under way (E59) — a form's optimistic update: gone once its answer is shown (the server's
   * props then), or when it fails.
   */
  optimistic?: OptimisticUpdate | readonly OptimisticUpdate[];
  /** The route's name: while a write is under way, it is listed in `navigator.submissions` by it (ghost rows). */
  name?: string;
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
  /** Fetched as a layer's request — for `<Link layer prefetch>` (the visit that opens it takes it). */
  layer?: boolean;
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
  /**
   * The positions of the page's `scroll-region` elements, in document order. (Named `regions` before W5b — entries of an
   * older document are still read; regions of a page, islands, are never in here: they live in memory, E36.)
   */
  readonly scrollRegions?: readonly ScrollPosition[];
  /** The entry's page in the in-memory cache — random, so entries of an earlier document never match. */
  readonly key: string;
  /**
   * A layer's entry (E53): how deep it is, and the keys of the entries beneath it (the page's first) — what Back/Forward
   * puts on screen with it. Keys only: what they show lives in memory.
   */
  readonly layer?: { readonly depth: number; readonly below: readonly string[] };
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
  readonly history: Pick<History, 'state' | 'pushState' | 'replaceState'> & {
    scrollRestoration?: ScrollRestoration;
    /** Back (`go(-n)`) — closing a layer goes back to the entry beneath. Without it, the entry is replaced. */
    go?(delta: number): void;
  };
  readonly location: Pick<Location, 'href' | 'origin' | 'pathname' | 'search' | 'assign' | 'replace' | 'reload'>;
  readonly scrollX: number;
  readonly scrollY: number;
  scrollTo(x: number, y: number): void;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  addEventListener(type: WindowEvent, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: WindowEvent, listener: (event: Event) => void, options?: EventListenerOptions): void;
  /** For `scroll-region` elements and `#fragment` targets. */
  readonly document?: {
    querySelectorAll(selectors: string): Iterable<ScrollRegion>;
    getElementById(id: string): { scrollIntoView(): void } | null;
    /** `loading` while the document still streams in — streamed deferred props wait for its end (E49). */
    readonly readyState?: string;
    addEventListener?(type: 'DOMContentLoaded', listener: () => void, options?: AddEventListenerOptions): void;
  };
  /** For the upload progress of `FormData` visits — `fetch` cannot report it (over HTTP/1.1). */
  readonly XMLHttpRequest?: new () => XMLHttpRequest;
}

/** What the navigator tells the adapter with a page to render. */
export interface RenderOptions {
  /** Keep component state (the same component stays mounted). */
  readonly preserveState: boolean;
  /** The regions of this page's history entry (see {@link Navigator.region}). */
  readonly owner: RegionOwner;
  /**
   * The layers over the page, bottom first (E53) — rendered over it, each with its own page object, visits and islands.
   * When only these change, `page` is the one on screen already (with `preserveState`): it must not render again.
   */
  readonly layers: readonly Layer[];
}

export interface NavigatorOptions {
  /** The page the server rendered (from `#bespoke-page`) — always fresh: a full load asks the server. */
  initialPage: PageObject;
  /**
   * Shows a page: resolve its component and render it. Resolves once it is on screen (scroll restores after that).
   * `owner` is where the page's regions (islands) live — its history entry's memory: the adapter hands it to
   * `navigator.region(url, { owner })`, so an island loads into the entry it is rendered for.
   */
  render: (page: PageObject, options: RenderOptions) => Promise<void>;
  /** Default: the browser's `window`. */
  window?: NavigatorWindow;
  /** Pages kept in memory, one per history entry; the least recently shown goes first. Default 20. */
  cacheSize?: number;
  /**
   * What a view declares to reload when Back/Forward shows it from memory (E58) — the adapter reads it from the view
   * (`Show.revalidateOnBack = ['notifications']`): `true` all its props, a list some of them, nothing (the default) none.
   * The page (or layer, or island) shows from memory at once; then those props load in the background, without a progress bar.
   */
  revalidateOnBack?: (component: string) => RevalidateOnBack | undefined | Promise<RevalidateOnBack | undefined>;
}

/** What a view reloads when Back/Forward shows it from memory (E58): all its props (`true`), some, or none (`false`). */
export type RevalidateOnBack = boolean | readonly string[];

/** How many pages the in-memory cache keeps by default. */
export const DEFAULT_PAGE_CACHE_SIZE = 20;

/** Scroll positions are written to the history entry this long after scrolling stops (browsers limit `replaceState` calls). */
const SCROLL_SAVE_DELAY = 100;

interface Scroll {
  scroll: ScrollPosition;
  scrollRegions: ScrollPosition[];
}

const TOP: Scroll = { scroll: { x: 0, y: 0 }, scrollRegions: [] };

/**
 * Navigates without full page loads: a visit fetches the next page object as JSON (`x-bespoke`), keeps it
 * in memory and pushes a history entry *without* its props. Back and Forward show the page from memory —
 * or ask the server when it is not there — and restore where it was scrolled to. A `409` with
 * `x-bespoke-location` (a new build, or signing in or out — `ClientHistory` on the server) loads that URL
 * fully and drops every page kept in memory. Every request reports its events (`on('start', …)`).
 */
export class Navigator implements LayerHost {
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
  /**
   * Deferred groups of the first page that the server streams with the document (E49, `streamedProps`): not asked for —
   * the adapter hands them over as they arrive (`receiveStreamed`).
   */
  readonly #streaming: Set<string>;
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
  /** The history entry and page the document was loaded with — what streamed deferred groups land in. */
  #firstKey: string | undefined;
  #firstPage: PageObject;
  /** Where the regions (islands) of the page on screen live — its history entry's; closed when the entry leaves the screen. */
  #owner: RegionOwner;
  readonly #transport: RegionTransport = { request: (url, headers, signal) => this.#regionRequest(url, headers, signal) };
  /** A page is being swapped in: scroll events belong to no entry until its position is set. */
  #transitioning = false;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The layers on screen over the page (E53), bottom first. `#key` stays the page's entry: the current history entry is the
   * top layer's (`#topKey()`).
   */
  #layers: LayerControl[] = [];
  /** The layers the document came with (a deep link of a layer's URL) — stacked once the history is taken over. */
  readonly #initialLayers: readonly PageObject[];
  /** A layer closing by going back in the history: what the popstate it caused finishes. */
  #pendingClose: PendingClose | undefined;
  /** Optimistic patches (E59) on the pages of history entries, by key — over the props in memory, never in them. */
  readonly #patches = new Map<string, EntryPatches>();
  /** Actions and route forms under way — what ghost rows are made of (E59). */
  readonly #submissions = new Submissions();
  readonly #actions: Actions;
  readonly #revalidateOnBack: NavigatorOptions['revalidateOnBack'];

  constructor({ initialPage, render, window: win = globalThis.window, cacheSize = DEFAULT_PAGE_CACHE_SIZE, revalidateOnBack }: NavigatorOptions) {
    this.#window = win;
    this.#render = render;
    this.#revalidateOnBack = revalidateOnBack;
    const navigator = this;
    this.#actions = new Actions(
      {
        get left() {
          return navigator.#left;
        },
        get href() {
          return navigator.#window.location.href;
        },
        fetch: (url, init) => this.#window.fetch(url, init),
        leaveFor: (location) => {
          this.#leave();
          this.#window.location.assign(location);
        },
        changed: () => this.#flushPrefetched(),
        visit: (url) => this.visit(url),
        request: (target, method, data) => buildRequest(target, method, data),
      },
      this.#submissions,
    );
    this.#cache = new PageCache(cacheSize, () => this.#onScreen());
    // A deep link of a layer's URL: the page under it (its base, or the neutral surface), the layers apart.
    const { layers: initialLayers, ...page } = initialPage;
    this.#initialLayers = (initialLayers ?? []).slice(0, MAX_LAYER_DEPTH);
    this.#page = page;
    this.#firstPage = page;
    this.#version = initialPage.version ?? null;
    this.#owner = new RegionOwner(this.#transport);
    this.#streaming = new Set(initialPage.streamedProps ?? []);
  }

  /** The page on screen — under the layers, when some are open. */
  get page(): PageObject {
    return this.#page;
  }

  /** The layers on screen over the page, bottom first (E53). */
  get layers(): readonly Layer[] {
    this.#adopt();
    return this.#layers.map((control) => control.layer);
  }

  /** How many pages are kept in memory (tests). */
  get cachedPages(): number {
    return this.#cache.size;
  }

  /** Where the regions of the page on screen live — for the adapter's first page (later ones come with `render`). */
  get regionOwner(): RegionOwner {
    this.#adopt();
    return this.#owner;
  }

  /**
   * A region of the page — an island (E48, E50): `url` is its route's (same origin), `owner` the entry it belongs to (what
   * `render` handed the adapter; default: the page on screen). The same URL gives the same region (one request for two
   * identical islands); what it loaded stays in the entry's memory, so Back/Forward shows it without a request. `initial`
   * is a region object the server already sent (streamed with the page). Islands never load ahead (no prefetch, E52).
   */
  region(url: string, { owner, initial }: { owner?: RegionOwner; initial?: RegionInitial } = {}): Region {
    this.#adopt();
    const target = new URL(url, this.#window.location.href);
    if (target.origin !== this.#window.location.origin) throw new Error(`A region comes from this site, not from ${target.origin} (${url}).`);
    return (owner ?? this.#owner).region(target.pathname + target.search, initial);
  }

  /**
   * A deferred group of the first page, as the server streamed it with the document (E49) — `null` when it did not
   * arrive (it failed on the server, or the adapter rendered its part in the browser): then it is asked for, as without
   * streaming. It lands once the document has finished streaming: an update of the page while an island of it is still
   * streaming would make the adapter render that island in the browser — and load it again.
   */
  async receiveStreamed(group: string, streamed: DeferredResult | null): Promise<void> {
    this.#adopt();
    if (!this.#streaming.delete(group) || this.#left) return;
    const key = this.#firstKey;
    const page = this.#firstPage;
    if (streamed === null) {
      // Not streamed after all: loaded like any deferred group — for the first page when it is on screen (else when it is shown again).
      if (this.#key === key) this.#loadDeferred();
      return;
    }
    const doc = this.#window.document;
    if (doc?.readyState === 'loading' && doc.addEventListener) await new Promise<void>((done) => doc.addEventListener!('DOMContentLoaded', done, { once: true }));
    if (key === undefined) return;
    await this.#land(key, page, { ...page, ...streamed, deferredProps: undefined } as PageObject);
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
    // The first render is on screen — now the props it was sent without (the layers' too).
    this.#loadDeferred();
    for (const control of this.#layers) this.#loadLayerDeferred(control);
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
   * An action (E59): a request that does not navigate — no history entry, nothing in the page cache, no progress bar. Its
   * optimistic patches show at once and are rolled back unless it succeeds; when it does, `reload` reloads what it names in
   * the background and its patches go once the server's props landed. Resolves with how it ended — never rejects for a
   * failed request (an `exception`: shown by the app, never retried by itself).
   */
  action(url: string, options: ActionOptions = {}): Promise<ActionOutcome> {
    this.#adopt();
    return this.#actions.run(url, options);
  }

  /** Actions and route forms under way, oldest first — what ghost rows are made of (E59 model 2). A new array on each change. */
  get submissions(): readonly Submission[] {
    return this.#submissions.list;
  }

  /** Follows {@link submissions}. Returns the function that stops it. */
  subscribeSubmissions(listener: () => void): () => void {
    return this.#submissions.subscribe(listener);
  }

  /**
   * A patch of the props of the page on screen (E59), for an action or a form: `optimistic((props) => ({ likes: props.likes + 1 }))`
   * — shown over the props in memory while the action is under way, never written into them before it succeeded.
   */
  optimistic(patch: PropsPatch): OptimisticUpdate {
    this.#adopt();
    return { target: this.#entryPatches(this.#key!).target, patch };
  }

  /** A reload of the page on screen for an action to run once it succeeded — some props (`only`), or all of them. */
  reloading(spec: ReloadSpec = {}): Reloading {
    this.#adopt();
    return { target: this.#entryPatches(this.#key!).target, spec };
  }

  /**
   * Resolves with the page the visit ended on — undefined if it did not end on a page: the browser took over,
   * a newer visit replaced it (`onCancel`), or it failed (`onException`). It never rejects for a failed request.
   */
  async visit(url: string, options: VisitOptions = {}): Promise<PageObject | undefined> {
    return this.#visit(undefined, url, options);
  }

  /** A visit from inside a layer (E53) — `layer.visit()`: sent as the layer's, its answer placed for it. */
  layerVisit(layer: Layer, url: string, options: VisitOptions): Promise<PageObject | undefined> {
    const from = this.#layers.find((control) => control.layer === layer);
    // A layer that left the screen visits nothing any more.
    if (!from) return Promise.resolve(undefined);
    return this.#visit(from, url, options);
  }

  /**
   * A visit — of the page (`from` undefined) or of a layer over it. Where its answer goes: a page replaces the page (and
   * the layers go) — unless it is a reload of the page under the layers, which lands there; a layer's answer opens over
   * the level it came from — or replaces that layer in place when it is the same one (its key: a failed form). A layer's
   * request that the server answers with `closeLayer()` closes it.
   */
  async #visit(from: LayerControl | undefined, url: string, options: VisitOptions): Promise<PageObject | undefined> {
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
    const current = from ? from.layer.page : this.#page;
    // A partial reload names the page (or layer) it reloads: the server sends only some props when it renders that one.
    const partial = options.only !== undefined || (options.except?.length ?? 0) > 0 ? current.component : undefined;
    const partialHeaders = partial === undefined ? {} : partialReloadHeaders(partial, options.only, options.except);
    // A layer's request (E53): from inside one, or opening one.
    const asLayer = from !== undefined || options.layer === true;
    const regionHeaders: Record<string, string> = asLayer ? { [REGION_HEADER]: 'layer' } : {};
    // A plain GET visit of a prefetched URL takes that page (or waits for its request, still under way).
    const prefetched =
      method === 'get' && partial === undefined && Object.keys(headers).length === 0 ? this.#takePrefetched(prefetchKey(request.url, asLayer)) : undefined;
    const visit: Visit = background ? { url: request.url, method, async: true } : { url: request.url, method };
    // An async visit lands only on the page (or the layer) it started from.
    const fromKey = this.#key;
    // A form's optimistic patches (E59): shown while it is under way, gone with its answer (or its failure).
    const applied = applyPatches(listOf(options.optimistic));
    const untrack = options.name !== undefined && method !== 'get' ? this.#submissions.add({ name: options.name, method, url: request.url, input: data }) : undefined;
    try {
      return await this.#request(visit, options, async (signal, onProgress) => {
        let page = prefetched ? await untilAborted(prefetched, signal) : undefined;
        if (!page) {
          if (signal.aborted) return undefined;
          const response = await this.#send(
            request.url,
            { method, headers: { ...request.headers, ...regionHeaders, ...partialHeaders, ...headers }, body: request.body, signal },
            onProgress,
          );
          if (response.headers.get(LAYER_CLOSE_HEADER) === 'true') return this.#closed(from, response, visit, options);
          page = await this.#read(response, { replace, failed: true }, visit, options);
        }
        if (!page || signal.aborted) return undefined;
        if (background && (this.#left || this.#key !== fromKey || this.#transitioning || from?.layer.closed)) return undefined;
        // The answer replaces what the patches showed — in the same render (the server's props then, or its errors).
        for (const [target, ids] of applied) target.settle(ids, false, { quiet: true });
        // Some props of the same page (or layer): into the ones it has. (Another page — a redirect to the login — came in full.)
        if (partial !== undefined && page.component === partial && current.component === partial) page = mergePage(current, page, options.reset);
        // The URL — and so the query state — stays the one of the page on screen.
        if (preserveUrl) page = withQueryOf({ ...page, url: current.url }, current);
        const shown = await this.#place(from, page, { method, replace, preserveScroll, preserveState, preserveUrl, partial: partial !== undefined, hash: preserveUrl ? '' : target.hash });
        if (shown) {
          const errors = validationErrors(shown);
          if (errors) this.#emit('error', options.onError, errors, visit);
          else this.#emit('success', options.onSuccess, shown, visit);
        }
        return shown;
      });
    } finally {
      // Failed, cancelled, or the browser took over: nothing of the patches stays.
      rollBack(applied);
      untrack?.();
    }
  }

  /** @internal A layer's reload for an action (E59) — see {@link LayerHost.reloadLayer}. */
  reloadLayer(layer: Layer, spec: ReloadSpec, drop: ReadonlySet<number>, signal: AbortSignal): Promise<boolean> {
    const control = this.#layers.find((candidate) => candidate.layer === layer);
    return control ? this.#revalidateLayer(control, spec, drop, signal) : Promise.resolve(false);
  }

  /** @internal Memory keeps what a layer's props became (an action's patches committed). */
  layerChanged(layer: Layer): void {
    this.#cache.updatePage(layer.entry, layer.page);
  }

  /** `closeLayer()` answered a layer's request: close, then the visit ends on what is beneath (a success). */
  async #closed(from: LayerControl | undefined, response: Response, visit: Visit, callbacks: VisitCallbacks): Promise<PageObject | undefined> {
    let close: LayerClose = { layers: 1 };
    try {
      const body = (await response.json()) as { close?: LayerClose };
      if (body.close && Number.isInteger(body.close.layers) && body.close.layers > 0) close = body.close;
    } catch {
      // No body: close the one layer.
    }
    if (!from || from.layer.closed) return undefined;
    await this.closeLayer(from.layer, close);
    const shown = this.#layers.at(-1)?.layer.page ?? this.#page;
    this.#emit('success', callbacks.onSuccess, shown, visit);
    return shown;
  }

  /** Where a visit's answer goes — see {@link Navigator.#visit}. */
  async #place(
    from: LayerControl | undefined,
    page: PageObject,
    options: { method: VisitMethod; replace: boolean; preserveScroll: boolean; preserveState: boolean; preserveUrl: boolean; partial: boolean; hash: string },
  ): Promise<PageObject | undefined> {
    const { method, replace, preserveScroll, preserveState, preserveUrl, partial, hash } = options;
    if (!page.layer) {
      // The page under the layers reloaded (a poll, deferred props, `reload({ only })`): it lands there, the layers and
      // their history entries stay.
      if (!from && this.#layers.length > 0 && page.component === this.#page.component && (partial || replace || preserveUrl)) {
        return this.#landPage(page, preserveState);
      }
      // Redirected back to the same URL (a failed form), or kept the URL ("load more"): replace, don't stack history entries.
      const sameUrl = page.url === this.#window.location.pathname + this.#window.location.search;
      const history = replace || preserveUrl || (method !== 'get' && sameUrl) ? 'replace' : 'push';
      return this.#show(page, history, { preserveScroll, preserveState, hash });
    }
    const at = from ? this.#layers.indexOf(from) : -1;
    if (from && at >= 0 && (page.layer.key === from.layer.key || (partial && page.component === from.layer.page.component))) {
      // The same layer — validation errors, a reload, the next step: in place. A GET that is no reload is a step of its own.
      const inPlace = replace || preserveUrl || partial || method !== 'get';
      return this.#replaceLayer(at, page, { push: !inPlace, preserveState });
    }
    // One more than the protocol allows: shown as a page.
    if (at + 2 > MAX_LAYER_DEPTH) return this.#show(page, 'push', { preserveScroll: false, preserveState: false, hash: '' });
    return this.#openLayer(at, page);
  }

  /** The page under the layers, reloaded: in place — its entry and the layers' stay, nothing scrolls. */
  async #landPage(page: PageObject, preserveState: boolean): Promise<PageObject> {
    this.#cache.updatePage(this.#key!, page);
    this.#setPage(page);
    await this.#render(this.#paint(this.#key!, page), { preserveState, owner: this.#owner, layers: this.layers });
    this.#loadDeferred();
    return page;
  }

  /**
   * Opens a layer over level `at` (-1: the page) — what was over that level goes. A history entry of its own (Back closes
   * it), the scroll position stays: the page does not move under it.
   */
  async #openLayer(at: number, page: PageObject): Promise<PageObject> {
    const wasTop = at === this.#layers.length - 1;
    this.#dismissFrom(at + 1);
    const leaving = this.#currentScroll();
    this.#cancelScrollSave();
    const top = this.#topKey();
    // The entry being left keeps where it was scrolled to.
    this.#positions.set(top, leaving);
    if (wasTop) this.#window.history.replaceState(this.#stateOf(top, leaving), '', this.#window.location.href);
    const below = this.#belowOf(at + 1);
    const key = newKey();
    const control = Layer.create(this, key, below.length, page, new RegionOwner(this.#transport));
    // Pushed right over the entry beneath: closing it is Back.
    this.#cache.set(key, { page, regions: control.layer.owner.regions, below, pushed: wasTop });
    this.#window.history.pushState(layerEntry(page, key, leaving, below), '', page.url);
    this.#positions.set(key, leaving);
    this.#layers.push(control);
    await this.#renderLayers();
    this.#loadLayerDeferred(control);
    return page;
  }

  /**
   * The layer at `at` answered with itself: replaced in place (its state kept when `preserveState`) — or, `push`, a new
   * entry at the same depth (a wizard's next step: Back goes to the step before).
   */
  async #replaceLayer(at: number, page: PageObject, { push, preserveState }: { push: boolean; preserveState: boolean }): Promise<PageObject> {
    this.#dismissFrom(at + 1);
    const current = this.#layers[at]!;
    const below = this.#belowOf(at);
    const position = this.#currentScroll();
    if (!push && preserveState) {
      current.update(page);
      const cached = this.#cache.peek(current.layer.entry);
      this.#cache.set(current.layer.entry, { page, regions: current.layer.owner.regions, below, pushed: cached?.pushed ?? false });
      this.#window.history.replaceState(layerEntry(page, current.layer.entry, position, below), '', page.url);
    } else {
      const key = push ? newKey() : current.layer.entry;
      const pushed = push ? true : (this.#cache.peek(key)?.pushed ?? false);
      // A new layer object (a fresh state) — the one it replaces is not forgotten when pushed over: Back shows it again.
      this.#layers.splice(at, 1);
      current.dismiss();
      if (!push && current.layer.once) this.#cache.delete(current.layer.entry);
      const control = Layer.create(this, key, below.length, page, new RegionOwner(this.#transport));
      this.#cache.set(key, { page, regions: control.layer.owner.regions, below, pushed });
      if (push) {
        this.#positions.set(current.layer.entry, position);
        this.#window.history.replaceState(layerEntry(current.layer.page, current.layer.entry, position, below), '', this.#window.location.href);
        this.#window.history.pushState(layerEntry(page, key, position, below), '', page.url);
      } else {
        this.#window.history.replaceState(layerEntry(page, key, position, below), '', page.url);
      }
      this.#positions.set(key, position);
      this.#layers.splice(at, 0, control);
      this.#loadLayerDeferred(control);
    }
    await this.#renderLayers();
    return page;
  }

  /**
   * Closes `layer` and `close.layers - 1` beneath it — and every layer over it (E53). When their entries were pushed one
   * over the other right over what stays, that is Back in the history (Forward then asks the server again: what closed is
   * forgotten); otherwise the current entry becomes what stays. Then `close.reload` reloads what is beneath — the page and
   * the layers that stay — and a layer shown once (an action's answer) reloads them fully.
   */
  async closeLayer(layer: Layer, close: LayerClose): Promise<void> {
    const index = this.#layers.findIndex((control) => control.layer === layer);
    if (index < 0 || this.#left) return;
    const keep = Math.max(0, index + 1 - Math.max(1, close.layers));
    const closing = this.#layers.slice(keep);
    const target = keep === 0 ? this.#key! : this.#layers[keep - 1]!.layer.entry;
    const forget = new Set(closing.map((control) => control.layer.entry));
    const state: unknown = this.#window.history.state;
    const onTop = isHistoryState(state) && state.key === this.#topKey();
    const back = this.#window.history.go !== undefined && onTop && closing.every((control) => this.#cache.peek(control.layer.entry)?.pushed === true);
    const reload = close.reload ?? (closing.some((control) => control.layer.once) ? true : undefined);
    if (back) {
      await new Promise<void>((done) => {
        const pending: PendingClose = { target, forget, reload, done };
        this.#pendingClose = pending;
        this.#window.history.go!(-closing.length);
        // The browser did not go back (it may refuse): the entry becomes what stays.
        setTimeout(() => {
          if (this.#pendingClose !== pending) return;
          this.#pendingClose = undefined;
          void this.#closeInPlace(keep, forget, reload).finally(done);
        }, CLOSE_TIMEOUT);
      });
      return;
    }
    await this.#closeInPlace(keep, forget, reload);
  }

  /** Closes every layer above `keep` by replacing the current entry with what stays. */
  async #closeInPlace(keep: number, forget: ReadonlySet<string>, reload: LayerClose['reload']): Promise<void> {
    if (this.#left) return;
    // Over the neutral surface (E54) there is nothing to go back to: the base is visited — the server says what it shows.
    if (keep === 0 && this.#page.component === LAYER_BACKDROP) {
      this.#dismissFrom(0);
      await this.visit(this.#page.url, { replace: true });
      return;
    }
    const position = this.#currentScroll();
    this.#dismissFrom(keep);
    for (const key of forget) this.#cache.delete(key);
    const top = this.#topKey();
    this.#window.history.replaceState(this.#stateOf(top, position), '', keep === 0 ? this.#page.url : this.#layers[keep - 1]!.layer.page.url);
    await this.#renderLayers();
    if (reload !== undefined) await this.#reloadTop(reload);
  }

  /**
   * Reloads what is on screen now — the page and every layer still over it, from the bottom up — some props (those a level
   * does not have are ignored), or (`true`) all of them: what the closed layer changed may show on any of them (a removed
   * link on the edit layer and on the profile under it). In the background, each landing in place; the page first, so a
   * flash message reaches the page's layout.
   */
  async #reloadTop(reload: NonNullable<LayerClose['reload']>): Promise<void> {
    if (reload !== true && reload.length === 0) return;
    const options: VisitOptions = { replace: true, preserveScroll: true, preserveState: true, async: true, ...(reload === true ? {} : { only: reload }) };
    const layers = [...this.#layers];
    await this.#visit(undefined, this.#page.url, options);
    for (const control of layers) if (!control.layer.closed) await this.#visit(control, control.layer.page.url, options);
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
    const { url: path } = buildRequest(target, 'get', options.data);
    if (path === this.#page.url && !options.layer) return Promise.resolve();
    const key = prefetchKey(path, options.layer === true);
    const existing = this.#prefetched.peek(key);
    if (existing && !existing.expired()) return existing.page.then(() => undefined);

    const cacheFor = options.cacheFor ?? DEFAULT_PREFETCH_CACHE_FOR;
    const controller = new AbortController();
    const entry: Prefetched = {
      controller,
      page: this.#fetchAhead(path, controller.signal, options.layer === true).then((page) => {
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
  async #fetchAhead(url: string, signal: AbortSignal, layer: boolean): Promise<PageObject | undefined> {
    try {
      const headers: Record<string, string> = layer ? { [PURPOSE_HEADER]: 'prefetch', [REGION_HEADER]: 'layer' } : { [PURPOSE_HEADER]: 'prefetch' };
      const response = await this.#send(url, { method: 'get', headers, signal });
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
    // The page's URL — not the window's: under a layer, the window shows the layer's.
    return this.visit(this.#page.url, { replace: true, preserveScroll: true, preserveState: true, ...options });
  }

  /**
   * The entry the document was loaded into gets a key, and its page goes into the cache — with the layers it came with (a
   * deep link): the page under them has no entry of its own then, the entry is the top layer's. Returns a restored entry.
   */
  #adopt(): HistoryState | undefined {
    if (this.#key !== undefined) return undefined;
    const state: unknown = this.#window.history.state;
    // A reload or session restore keeps the entry's key (and scroll); the page itself came fresh from the server.
    const restored = isHistoryState(state) ? state : undefined;
    const key = restored?.key ?? newKey();
    const position = restored ? this.#positionOf(restored) : TOP;
    this.#key = this.#initialLayers.length > 0 ? newKey() : key;
    this.#firstKey = this.#key;
    this.#firstPage = this.#page;
    this.#cache.set(this.#key, { page: this.#page, regions: this.#owner.regions });
    if (this.#initialLayers.length === 0) {
      this.#window.history.replaceState(entry(this.#page, this.#key, position), '', this.#window.location.href);
      return restored;
    }
    const below = [this.#key];
    this.#initialLayers.forEach((page, index) => {
      const own = index === this.#initialLayers.length - 1 ? key : newKey();
      const control = Layer.create(this, own, index + 1, page, new RegionOwner(this.#transport));
      // Not pushed over an entry of their own: closing one replaces the entry with what is beneath.
      this.#cache.set(own, { page, regions: control.layer.owner.regions, below: [...below], pushed: false });
      this.#layers.push(control);
      below.push(own);
    });
    const top = this.#layers.at(-1)!.layer;
    this.#window.history.replaceState(layerEntry(top.page, key, position, below.slice(0, -1)), '', this.#window.location.href);
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
    // The page's islands: those of the page on screen when its state is kept (the same component — a partial reload, a
    // sort link): replaced in place, they stay; pushed, the new entry starts with a copy. Any other page starts empty.
    const keep = preserveState && page.component === this.#page.component;
    // A page replaces the layers too (E53): the entry being left (or replaced) is the top layer's.
    const layered = this.#layers.length > 0;
    const owner = history === 'replace' && keep && !layered ? this.#owner : new RegionOwner(this.#transport, keep ? new Map(this.#owner.regions) : new Map());
    // The entry the page goes into: a new one, or the one on screen (then its optimistic patches still show over the answer).
    const top = this.#topKey();
    const key = history === 'push' ? newKey() : top;
    try {
      try {
        await this.#render(this.#paint(key, page), { preserveState, owner, layers: [] });
      } catch {
        // The page's code could not be loaded (a chunk gone after a deployment, offline): the browser loads it.
        if (owner !== this.#owner) owner.close();
        this.#leave();
        this.#window.location.assign(page.url);
        return undefined;
      }
      const { history: browserHistory } = this.#window;
      const arrived = preserveScroll ? this.#currentScroll() : TOP;
      if (history === 'push') {
        // Remember where the page being left was scrolled to — Back restores it.
        this.#positions.set(top, leaving);
        browserHistory.replaceState(this.#stateOf(top, leaving), '', this.#window.location.href);
        this.#key = key;
        browserHistory.pushState(entry(page, this.#key, arrived), '', page.url + hash);
      } else {
        // Replacing a layer's entry: the entry is this page's now.
        this.#key = top;
        browserHistory.replaceState(entry(page, this.#key, arrived), '', page.url + hash);
      }
      this.#dismissFrom(0);
      this.#positions.set(this.#key!, arrived);
      this.#cache.set(this.#key!, { page, regions: owner.regions });
      this.#switchOwner(owner);
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
    // Going back because a layer closes: the visit that closed it (a form's `closeLayer()`) is not cancelled by it.
    const closing = this.#pendingClose;
    this.#pendingClose = undefined;
    if (!closing) this.#inFlight?.abort();
    // A save still pending belongs to the entry just left; the browser already switched to the new one.
    this.#cancelScrollSave();
    if (isHistoryState(state)) {
      const stack = this.#cachedStack(state.key);
      if (stack) {
        void this.#arriveAt(state, stack, closing);
        return;
      }
      closing?.done();
      if (state.layer) void this.#restoreLayer(state);
      else void this.#restore(state.url, state.key, this.#positionOf(state));
      return;
    }
    closing?.done();
    // An entry of an older client, which kept whole pages in the history: never shown — the server is asked.
    if (isPageObject(state)) void this.#restore(state.url, newKey(), TOP);
  };

  /**
   * Back/Forward to an entry in memory: its page and the layers over it. When it is the page on screen with other layers
   * (a layer closed by Back, opened again by Forward), only the layers change — the page is not rendered again, does not
   * scroll, and none of its deferred props or islands load again.
   */
  async #arriveAt(state: HistoryState, stack: CachedStack, closing: PendingClose | undefined): Promise<void> {
    try {
      if (stack.page === this.#key && !this.#left) {
        const before = new Set(this.#layers);
        const removed = this.#setLayers(stack.layers);
        for (const key of closing?.forget ?? []) this.#cache.delete(key);
        await this.#renderLayers();
        // Layers Forward opened again from memory: what their views declare reloads (E58) — the page stayed on screen.
        if (!closing) for (const control of this.#layers) if (!before.has(control)) void this.#revalidateLayerOnBack(control);
        // An action's answer (shown once) left: what is beneath reloads — or what the closing asked for.
        const reload = closing?.reload ?? (removed.some((layer) => layer.once) ? true : undefined);
        if (reload !== undefined) await this.#reloadTop(reload);
        return;
      }
      this.#dismissFrom(0);
      for (const key of closing?.forget ?? []) this.#cache.delete(key);
      const base = this.#cache.peek(stack.page)!;
      this.#key = stack.page;
      // The entry's islands come back with it, from memory — no request (but what their views declare reloads, E58).
      const owner = new RegionOwner(this.#transport, base.regions, { onBack: this.#regionOnBack });
      this.#switchOwner(owner);
      this.#setPage(base.page);
      this.#setLayers(stack.layers, { restored: true });
      await this.#arrive(base.page, this.#positionOf(state), owner);
      // Shown from memory at once — then what the views declare reloads in the background (E58).
      if (!closing && this.#key === stack.page) {
        void this.#revalidatePageOnBack(stack.page, base.page);
        for (const control of this.#layers) void this.#revalidateLayerOnBack(control);
      }
    } finally {
      closing?.done();
    }
  }

  /** Renders a page of the history and scrolls to where it was. */
  async #arrive(page: PageObject, position: Scroll, owner: RegionOwner): Promise<void> {
    this.#transitioning = true;
    try {
      await this.#render(this.#paint(this.#key!, page), { preserveState: false, owner, layers: this.layers });
      this.#applyScroll(position);
      this.#loadDeferred();
      for (const control of this.#layers) this.#loadLayerDeferred(control);
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
      this.#dismissFrom(0);
      this.#key = key;
      const owner = new RegionOwner(this.#transport);
      this.#cache.set(key, { page, regions: owner.regions });
      this.#switchOwner(owner);
      this.#setPage(page);
      await this.#arrive(page, position, owner);
      return page;
    });
  }

  /**
   * Back/Forward to a layer's entry that is not in memory (closed explicitly, shown once, evicted): asked for again — over
   * what is beneath it, when that is on screen or in memory. Otherwise the whole stack loads like a deep link (the server
   * puts the layer's declared base under it).
   */
  async #restoreLayer(state: HistoryState): Promise<void> {
    const below = state.layer?.below ?? [];
    const beneath = below.length > 0 ? this.#cachedStack(below.at(-1)!) : undefined;
    if (!beneath || beneath.page !== this.#key) {
      this.#leave();
      this.#window.location.reload();
      return;
    }
    const position = this.#positionOf(state);
    const visit: Visit = { url: state.url, method: 'get' };
    await this.#request(visit, {}, async (signal) => {
      const response = await this.#send(state.url, { method: 'get', headers: { [REGION_HEADER]: 'layer' }, signal });
      const page = await this.#read(response, { replace: true, failed: false }, visit, {});
      if (!page || signal.aborted) return undefined;
      if (!page.layer) {
        // A page now (signed out: the login page): the entry is that page.
        await this.#restorePage(page, state.key, position);
        return page;
      }
      this.#setLayers(beneath.layers);
      const control = Layer.create(this, state.key, beneath.layers.length + 1, page, new RegionOwner(this.#transport));
      const keys = [beneath.page, ...beneath.layers.map((level) => level.key)];
      this.#cache.set(state.key, { page, regions: control.layer.owner.regions, below: keys, pushed: false });
      this.#window.history.replaceState(layerEntry(page, state.key, position, keys), '', page.url);
      this.#layers.push(control);
      await this.#renderLayers();
      this.#loadLayerDeferred(control);
      return page;
    });
  }

  /** The entry `key` shows `page` now (a page where a layer was). */
  async #restorePage(page: PageObject, key: string, position: Scroll): Promise<void> {
    this.#window.history.replaceState(entry(page, key, position), '', page.url);
    this.#dismissFrom(0);
    this.#key = key;
    const owner = new RegionOwner(this.#transport);
    this.#cache.set(key, { page, regions: owner.regions });
    this.#switchOwner(owner);
    this.#setPage(page);
    await this.#arrive(page, position, owner);
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
      // On its way in the document's stream (E49): not asked for.
      if (key === this.#firstKey && this.#streaming.has(group)) continue;
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

  /**
   * Merges loaded props into the page of history entry `key` — and shows it, if that is the page on screen. `replace`: the
   * loaded page is the whole page now (a full reload) — its deferred props keep their values until they load again. `drop`:
   * optimistic patches the landing props take the place of (E59), gone in the same render.
   */
  async #land(key: string, page: PageObject, loaded: PageObject, { replace = false, drop }: { replace?: boolean; drop?: ReadonlySet<number> } = {}): Promise<PageObject | undefined> {
    // Left for a full page load (signed out, say): nothing lands in what this document shows any more.
    if (this.#left) return undefined;
    const onScreen = this.#key === key && !this.#transitioning;
    const target = onScreen ? this.#page : this.#cache.peek(key)?.page;
    // The entry shows another URL now (a replacing visit): these props are not for it.
    if (!target || target.url !== page.url || target.component !== page.component) return undefined;
    const merged = replace ? keepDeferred(target, loaded) : mergePage(target, loaded);
    this.#cache.updatePage(key, merged);
    if (drop) this.#patches.get(key)?.queue.remove(drop);
    if (onScreen) {
      this.#setPage(merged);
      await this.#render(this.#paint(key, merged), { preserveState: true, owner: this.#owner, layers: this.layers });
      if (replace) this.#loadDeferred();
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
    // `regions`: what the scroll regions were called before W5b — an entry of an older document of this tab.
    const legacy = (state as { regions?: readonly ScrollPosition[] }).regions;
    return this.#positions.get(state.key) ?? { scroll: state.scroll ?? TOP.scroll, scrollRegions: [...(state.scrollRegions ?? legacy ?? [])] };
  }

  #scrollRegions(): ScrollRegion[] {
    return this.#window.document ? [...this.#window.document.querySelectorAll(`[${SCROLL_REGION_ATTRIBUTE}]`)] : [];
  }

  #currentScroll(): Scroll {
    return {
      scroll: { x: this.#window.scrollX, y: this.#window.scrollY },
      scrollRegions: this.#scrollRegions().map((region) => ({ x: region.scrollLeft, y: region.scrollTop })),
    };
  }

  #applyScroll({ scroll, scrollRegions }: Scroll): void {
    this.#window.scrollTo(scroll.x, scroll.y);
    this.#scrollRegions().forEach((region, index) => {
      const position = scrollRegions[index] ?? TOP.scroll;
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

  /** The page on screen now belongs to `owner`'s entry: the regions of the one before stop (their requests are aborted). */
  #switchOwner(owner: RegionOwner): void {
    if (owner === this.#owner) return;
    this.#owner.close();
    this.#owner = owner;
  }

  /**
   * A region's request (E52): a GET with the page headers and `x-bespoke-region: island`, never following a redirect. What
   * the server answers becomes the region's outcome — never a navigation of the page — except a 409: a new build (or a
   * document change), so the whole page loads again (the island's code of this build may be gone).
   */
  async #regionRequest(url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<RegionResponse> {
    if (this.#left || signal.aborted) return { kind: 'cancelled' };
    let response: Response;
    try {
      response = await this.#window.fetch(url, {
        method: 'GET',
        headers: { [PAGE_HEADER]: 'true', [REGION_HEADER]: 'island', ...(this.#version ? { [VERSION_HEADER]: this.#version } : {}), ...headers },
        signal,
        redirect: 'manual',
      });
    } catch (cause) {
      return signal.aborted || this.#left ? { kind: 'cancelled' } : { kind: 'exception', failure: { status: undefined, cause } };
    }
    if (this.#left || signal.aborted) {
      await response.body?.cancel();
      return { kind: 'cancelled' };
    }
    if (response.status === 409 && response.headers.has(LOCATION_HEADER)) {
      this.#leave();
      this.#window.location.reload();
      return { kind: 'cancelled' };
    }
    const outcome = response.headers.get(REGION_STATUS_HEADER);
    // The server turns redirects, 401 and 403 into an outcome; a redirect not turned (a proxy) is never followed either.
    if (outcome === 'unauthorized' || response.type === 'opaqueredirect' || response.status === 401 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      return { kind: 'unauthorized' };
    }
    if (outcome === 'forbidden' || response.status === 403) {
      await response.body?.cancel();
      return { kind: 'forbidden' };
    }
    if (response.ok && response.headers.get(REGION_HEADER) === 'island') return { kind: 'region', region: (await response.json()) as RegionObject };
    let message: string | undefined;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // Not JSON (a proxy's error page): the status says enough.
    }
    return { kind: 'exception', failure: { status: response.status || undefined, message } };
  }

  // -- Optimistic patches and revalidation (E58, E59) ----------------------------------------------------------------

  /** The page of entry `key` as it is shown: the props in memory with the optimistic patches under way over them. */
  #paint(key: string, page: PageObject): PageObject {
    return this.#patches.get(key)?.queue.apply(page) ?? page;
  }

  /** The props in memory of entry `key`'s page — the server's (never a patch). */
  #basePage(key: string): PageObject | undefined {
    return key === this.#key ? this.#page : this.#cache.peek(key)?.page;
  }

  /** The patches of entry `key` changed: shown again, if it is the page on screen. */
  #repaint(key: string): void {
    if (key !== this.#key || this.#transitioning || this.#left) return;
    void this.#render(this.#paint(key, this.#page), { preserveState: true, owner: this.#owner, layers: this.layers });
  }

  /** The optimistic patches of entry `key` — a target for actions, kept apart from the page in memory. */
  #entryPatches(key: string): EntryPatches {
    const existing = this.#patches.get(key);
    if (existing) return existing;
    const queue = new PatchQueue();
    const revalidations = new Revalidations();
    const target: PatchTarget = {
      add: (patch) => {
        const id = queue.add(patch);
        this.#repaint(key);
        return id;
      },
      settle: (ids, commit, { quiet = false } = {}) => {
        if (!ids.some((id) => queue.has(id))) return;
        const base = commit ? this.#basePage(key) : undefined;
        // Its action succeeded and nothing reloads it: what the patches show is the state now — in memory, like a reload's props.
        if (base) {
          const folded = queue.fold(base, ids);
          this.#cache.updatePage(key, folded);
          if (key === this.#key) this.#setPage(folded);
        }
        queue.remove(ids);
        if (!quiet) this.#repaint(key);
      },
      revalidate: (spec, ids) =>
        revalidations.run(
          spec,
          ids,
          (united, all, signal) => this.#revalidatePage(key, united, all, signal),
          (all) => target.settle(all, true),
        ),
    };
    const entry: EntryPatches = { queue, revalidations, target };
    this.#patches.set(key, entry);
    return entry;
  }

  /**
   * Reloads the page of entry `key` in the background — some props, or all — and lands them there (on screen or in memory),
   * taking the patches `drop` out in the same render. No events, no progress bar, no failure notice: what is shown stays when
   * it fails. Resolves with whether it landed.
   */
  async #revalidatePage(key: string, spec: ReloadSpec, drop: ReadonlySet<number>, signal: AbortSignal): Promise<boolean> {
    const base = this.#basePage(key);
    if (!base || this.#left) return false;
    const partial = spec.only !== undefined || (spec.except?.length ?? 0) > 0;
    const loaded = await this.#fetchPage(base.url, partial ? partialReloadHeaders(base.component, spec.only, spec.except) : {}, signal);
    // Another page (signed out meanwhile: the login page) is not what was asked for.
    if (!loaded || signal.aborted || loaded.component !== base.component) return false;
    const props = partial && spec.only ? pick(loaded.props, spec.only) : loaded.props;
    const landed = await this.#land(key, base, { ...loaded, props }, { replace: !partial, drop });
    return landed !== undefined;
  }

  /** A layer's props again from the server, in the background (as {@link Navigator.#revalidatePage}). */
  async #revalidateLayer(control: LayerControl, spec: ReloadSpec, drop: ReadonlySet<number>, signal: AbortSignal): Promise<boolean> {
    const base = control.layer.page;
    if (control.layer.closed || this.#left) return false;
    const partial = spec.only !== undefined || (spec.except?.length ?? 0) > 0;
    const headers = { [REGION_HEADER]: 'layer', ...(partial ? partialReloadHeaders(base.component, spec.only, spec.except) : {}) };
    const loaded = await this.#fetchPage(base.url, headers, signal);
    const current = control.layer.page;
    if (!loaded || signal.aborted || control.layer.closed || this.#left || current.url !== base.url || current.component !== loaded.component) return false;
    const merged = partial ? mergePage(current, { ...loaded, props: spec.only ? pick(loaded.props, spec.only) : loaded.props }) : keepDeferred(current, loaded);
    control.update(merged, drop);
    this.#cache.updatePage(control.layer.entry, merged);
    await this.#renderLayers();
    if (!partial) this.#loadLayerDeferred(control);
    return true;
  }

  /**
   * A page object fetched in the background — undefined for anything else (offline, a 4xx/5xx, not a page). Silent: no
   * events. A 409 with a location still changes the document (signed out, a new build).
   */
  async #fetchPage(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<PageObject | undefined> {
    if (this.#left) return undefined;
    const controller = new AbortController();
    this.#background.add(controller);
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      const response = await this.#send(url, { method: 'get', headers, signal: combined });
      if (this.#left || combined.aborted) {
        await response.body?.cancel();
        return undefined;
      }
      const location = response.status === 409 ? response.headers.get(LOCATION_HEADER) : null;
      if (location) {
        this.#leave();
        this.#window.location.assign(location);
        return undefined;
      }
      if (!response.ok || response.headers.get(PAGE_HEADER) !== 'true') {
        await response.body?.cancel();
        return undefined;
      }
      return (await response.json()) as PageObject;
    } catch {
      return undefined;
    } finally {
      this.#background.delete(controller);
    }
  }

  /** What the view `component` reloads when Back/Forward shows it from memory (E58) — none when it says nothing (or not something valid). */
  async #declared(component: string): Promise<ReloadSpec | undefined> {
    if (!this.#revalidateOnBack) return undefined;
    let declared: RevalidateOnBack | undefined;
    try {
      declared = await this.#revalidateOnBack(component);
    } catch {
      return undefined;
    }
    if (declared === true) return {};
    if (Array.isArray(declared) && declared.length > 0 && declared.every((prop) => typeof prop === 'string')) return { only: [...declared] };
    return undefined;
  }

  /** Back/Forward showed entry `key`'s page from memory: what its view declares reloads in the background (E58). */
  async #revalidatePageOnBack(key: string, page: PageObject): Promise<void> {
    const spec = await this.#declared(page.component);
    if (!spec || this.#key !== key || this.#left) return;
    await this.#revalidatePage(key, spec, new Set(), new AbortController().signal);
  }

  /** Back/Forward showed a layer from memory: what its view declares reloads in the background (E58). */
  async #revalidateLayerOnBack(control: LayerControl): Promise<void> {
    const spec = await this.#declared(control.layer.page.component);
    if (!spec || control.layer.closed || this.#left) return;
    await this.#revalidateLayer(control, spec, new Set(), new AbortController().signal);
  }

  /** What an island shown from memory by Back/Forward declares to reload (E58) — for the regions of entries brought back. */
  readonly #regionOnBack = (component: string): Promise<ReloadSpec | undefined> => this.#declared(component);

  // -- Layers (E53) ----------------------------------------------------------------------------------------------

  /** The current history entry: the top layer's, or the page's. */
  #topKey(): string {
    return this.#layers.at(-1)?.layer.entry ?? this.#key!;
  }

  /** The history state of entry `key` on screen — the page's, or a layer's (with the keys beneath it). */
  #stateOf(key: string, position: Scroll): HistoryState {
    const index = this.#layers.findIndex((control) => control.layer.entry === key);
    if (index < 0) return entry(this.#page, key, position);
    return layerEntry(this.#layers[index]!.layer.page, key, position, this.#belowOf(index));
  }

  /** The keys of the entries beneath the layer at `index`: the page's, then the layers' under it. */
  #belowOf(index: number): string[] {
    return [this.#key!, ...this.#layers.slice(0, index).map((control) => control.layer.entry)];
  }

  /** The keys on screen — never evicted from memory while they are. */
  #onScreen(): ReadonlySet<string> {
    const keys = new Set<string>();
    if (this.#key !== undefined) keys.add(this.#key);
    for (const control of this.#layers) keys.add(control.layer.entry);
    return keys;
  }

  /**
   * The layers from `index` up leave the screen (in their order from the top): their islands stop, `onClose` runs, and a
   * layer shown once is forgotten. Returns them.
   */
  #dismissFrom(index: number): Layer[] {
    const removed = this.#layers.splice(Math.max(0, index));
    for (const control of removed.reverse()) {
      control.dismiss();
      if (control.layer.once) this.#cache.delete(control.layer.entry);
    }
    return removed.map((control) => control.layer);
  }

  /**
   * The layers on screen become `levels` (from memory): the ones they share at the bottom stay as they are, the others
   * leave, the new ones are made from memory. Returns the layers that left.
   */
  #setLayers(levels: readonly CachedLevel[], { restored = true }: { restored?: boolean } = {}): Layer[] {
    let same = 0;
    while (same < levels.length && same < this.#layers.length && this.#layers[same]!.layer.entry === levels[same]!.key) same++;
    const removed = this.#dismissFrom(same);
    for (const level of levels.slice(same)) {
      // From memory (Back/Forward): its islands too — what their views declare reloads (E58).
      const owner = new RegionOwner(this.#transport, level.entry.regions, restored ? { onBack: this.#regionOnBack } : {});
      const control = Layer.create(this, level.key, level.depth, level.entry.page, owner);
      this.#layers.push(control);
      this.#loadLayerDeferred(control);
    }
    return removed;
  }

  /** The layers changed, the page did not: rendered with the same page (kept as it is). */
  async #renderLayers(): Promise<void> {
    await this.#render(this.#paint(this.#key!, this.#page), { preserveState: true, owner: this.#owner, layers: this.layers });
  }

  /** What memory keeps of the stack of entry `key` — its page's entry and the layers' — or undefined when a part is gone. */
  #cachedStack(key: string): CachedStack | undefined {
    const top = this.#cache.get(key);
    if (!top) return undefined;
    if (!top.below || top.below.length === 0) return { page: key, layers: [] };
    const [page, ...under] = top.below;
    if (!this.#cache.peek(page!)) return undefined;
    const layers: CachedLevel[] = [];
    for (const [index, below] of under.entries()) {
      const cached = this.#cache.peek(below);
      if (!cached) return undefined;
      layers.push({ key: below, depth: index + 1, entry: cached });
    }
    layers.push({ key, depth: under.length + 1, entry: top });
    return { page: page!, layers };
  }

  /** A layer's deferred props: one partial request per group, as the layer's — each merged in if it still shows that page. */
  #loadLayerDeferred(control: LayerControl): void {
    const page = control.layer.page;
    if (!page.deferredProps) return;
    for (const [group, props] of Object.entries(page.deferredProps)) {
      const id = `${control.layer.entry} ${group}`;
      if (props.length === 0 || this.#loading.has(id)) continue;
      this.#loading.add(id);
      const visit: Visit = { url: page.url, method: 'get', async: true };
      void this.#request(visit, {}, async (signal) => {
        const response = await this.#send(page.url, { method: 'get', headers: { [REGION_HEADER]: 'layer', ...partialReloadHeaders(page.component, props, undefined) }, signal });
        const loaded = await this.#read(response, { replace: true, failed: true }, visit, {});
        const current = control.layer.page;
        if (!loaded || control.layer.closed || this.#left || current.url !== page.url || current.component !== loaded.component) return undefined;
        const only = { ...loaded, props: Object.fromEntries(props.filter((prop) => Object.hasOwn(loaded.props, prop)).map((prop) => [prop, loaded.props[prop]])) };
        const merged = mergePage(current, only);
        control.update(merged);
        this.#cache.updatePage(control.layer.entry, merged);
        await this.#renderLayers();
        return merged;
      }).finally(() => this.#loading.delete(id));
    }
  }

  /** Before a full page load: nothing kept in memory survives it, should the browser bring this document back. */
  #leave(): void {
    this.#left = true;
    // Nothing optimistic either, and no action lands any more (signed out: their answers are not for whoever comes next).
    for (const { queue, revalidations } of this.#patches.values()) {
      queue.clear();
      revalidations.abort();
    }
    this.#patches.clear();
    this.#actions.abortAll();
    this.#submissions.clear();
    // Islands too: none of them lands any more, and none of what they showed survives (signing out). Layers alike.
    this.#owner.close();
    for (const control of this.#layers) control.dismiss();
    this.#layers = [];
    this.#cache.clear();
    // Prefetched while signed in: not for whoever comes next — and one still under way lands nowhere.
    this.#flushPrefetched();
    // A deferred prop still loading must not come back into a page of someone who has left (signed out).
    for (const request of this.#background) request.abort();
  }
}

/** The optimistic patches of one history entry's page, and the reloads actions start for it. */
interface EntryPatches {
  readonly queue: PatchQueue;
  readonly revalidations: Revalidations;
  readonly target: PatchTarget;
}

function listOf<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

/** Only these props. */
function pick(props: Readonly<Record<string, unknown>>, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(names.filter((name) => Object.hasOwn(props, name)).map((name) => [name, props[name]]));
}

/**
 * A full reload's page in place of `current`: its deferred props (sent without, to load next) keep their values until they
 * load again — the page shows them instead of their fallback in between.
 */
function keepDeferred(current: PageObject, loaded: PageObject): PageObject {
  const deferred = Object.values(loaded.deferredProps ?? {}).flat();
  const kept = pick(current.props, deferred.filter((name) => !Object.hasOwn(loaded.props, name)));
  return Object.keys(kept).length === 0 ? loaded : { ...loaded, props: { ...kept, ...loaded.props } };
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

/** A layer closing by going back: what the popstate it caused finishes (and the closing visit waits for). */
interface PendingClose {
  /** The entry it goes back to. */
  readonly target: string;
  /** The entries of the layers that close — forgotten: Forward asks the server again. */
  readonly forget: ReadonlySet<string>;
  readonly reload: LayerClose['reload'];
  readonly done: () => void;
}

/** How long a layer's close waits for the browser to go back before it replaces the entry instead (ms). */
const CLOSE_TIMEOUT = 1000;

/** One layer of a stack kept in memory. */
interface CachedLevel {
  readonly key: string;
  readonly depth: number;
  readonly entry: CachedEntry;
}

/** What memory keeps of an entry's stack: the key of the page's entry, the layers over it. */
interface CachedStack {
  readonly page: string;
  readonly layers: readonly CachedLevel[];
}

/** The prefetch of `url` — kept apart for a layer's request (another answer: the layer's, not a page). */
function prefetchKey(url: string, layer: boolean): string {
  return layer ? `layer ${url}` : url;
}

/** The history state of a layer's entry: where it is, how deep, and the keys beneath it — never what it shows (E36). */
function layerEntry(page: PageObject, key: string, position: Scroll, below: readonly string[]): HistoryState {
  return { ...entry(page, key, position), layer: { depth: below.length, below: [...below] } };
}

/** The headers of a partial reload of `component`. */
function partialReloadHeaders(component: string, only: readonly string[] | undefined, except: readonly string[] | undefined): Record<string, string> {
  return {
    [PARTIAL_COMPONENT_HEADER]: component,
    ...(only === undefined ? {} : { [PARTIAL_DATA_HEADER]: only.join(',') }),
    ...(except && except.length > 0 ? { [PARTIAL_EXCEPT_HEADER]: except.join(',') } : {}),
  };
}

/** The validation errors a page carries (the shared `errors` prop), or undefined when there are none. */
function validationErrors(page: PageObject): ValidationErrors | undefined {
  const errors = (page.props as { errors?: unknown }).errors;
  return typeof errors === 'object' && errors !== null && Object.keys(errors).length > 0 ? (errors as ValidationErrors) : undefined;
}

function entry(page: PageObject, key: string, position: Scroll): HistoryState {
  return withPosition({ component: page.component, url: page.url, key, scroll: position.scroll }, position);
}

/** The state with the position — `scrollRegions` only when the page has any (and never the old name, `regions`). */
function withPosition(state: HistoryState, { scroll, scrollRegions }: Scroll): HistoryState {
  const { scrollRegions: _old, regions: _legacy, ...rest } = state as HistoryState & { regions?: unknown };
  return scrollRegions.length > 0 ? { ...rest, scroll, scrollRegions } : { ...rest, scroll };
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

/**
 * What memory keeps of a history entry: its page (a layer's, for a layer's entry) and the region objects of its islands —
 * one entry of the LRU together. A layer's entry also names the entries beneath it.
 */
interface CachedEntry {
  readonly page: PageObject;
  readonly regions: Map<string, KeptRegion>;
  /** A layer's entry (E53): the keys of the entries beneath it, the page's first. */
  readonly below?: readonly string[];
  /** It was pushed right over the entry beneath it, in this document: closing it is Back. */
  readonly pushed?: boolean;
}

/**
 * History entries by key, least recently used first out — but never an entry on screen, and a layer's entries beneath
 * count as used with it (the page under a layer stays while the layer does).
 */
class PageCache {
  readonly #entries = new Map<string, CachedEntry>();
  readonly #size: number;
  readonly #pinned: () => ReadonlySet<string>;

  constructor(size: number, pinned: () => ReadonlySet<string>) {
    this.#size = Math.max(1, size);
    this.#pinned = pinned;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): CachedEntry | undefined {
    const cached = this.#entries.get(key);
    if (cached) this.set(key, cached);
    return cached;
  }

  peek(key: string): CachedEntry | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: CachedEntry): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    // What is beneath a layer is used with it — newer than it, so it goes after it.
    for (const below of value.below ?? []) {
      const entry = this.#entries.get(below);
      if (!entry) continue;
      this.#entries.delete(below);
      this.#entries.set(below, entry);
    }
    if (this.#entries.size <= this.#size) return;
    // Never what is on screen — nor the entry just set (it may be going on screen).
    const pinned = this.#pinned();
    for (const oldest of [...this.#entries.keys()]) {
      if (this.#entries.size <= this.#size) break;
      if (!pinned.has(oldest) && oldest !== key) this.#entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  /** A new page object for an entry that is there (props merged in), keeping its regions and its place. */
  updatePage(key: string, page: PageObject): void {
    const cached = this.#entries.get(key);
    if (cached) this.#entries.set(key, { ...cached, page });
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

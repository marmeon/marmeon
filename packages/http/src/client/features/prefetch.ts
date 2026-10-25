/**
 * Prefetching: a page fetched ahead of its visit (a hovered link) — GET only, `Purpose: prefetch`, in memory only.
 * Used once, by the visit it was fetched for, within its `cacheFor`; dropped when the document is left (signing out) and
 * when a non-GET visit changes what it shows. Its code loads with the first prefetch (`prefetchWith` in `lazy.ts`). A link that
 * prefetches when it scrolls into view (`observe`) goes through a short queue with fixed limits, so a long list is no flood.
 */
import { FLASH_WAITING_HEADER, PURPOSE_HEADER, REGION_HEADER, speaksProtocol, type PageObject } from '../../protocol.ts';
import { LruMap } from '../cache.ts';
import type { FeatureHost } from '../core.ts';
import { defineFeature, slot } from '../feature.ts';
import { takeFlash } from '../flash.ts';
import { DEFAULT_PREFETCH_CACHE_FOR } from '../links.ts';
import { buildRequest } from '../request.ts';

/** A prefetch: always a GET (`data` goes into the query string). */
export interface PrefetchOptions {
  /** How long the prefetched page may be shown instead of asking the server, in ms (default 30 000). */
  cacheFor?: number;
  data?: Record<string, unknown>;
  /** Fetched as a layer's request — for `<Link layer prefetch>` (the visit that opens it takes it). */
  layer?: boolean;
}

/** Prefetched pages kept at most (the oldest goes first). */
const PREFETCH_LIMIT = 30;

/** How long a link stays half visible before it queues (ms): scrolling past it does not. */
const VIEWPORT_DWELL_MS = 250;
/** Viewport prefetches and code loads under way at once. */
const VIEWPORT_CONCURRENCY = 2;
/** Viewport prefetches started for one displayed page (code loads do not count); a visit that lands starts the count again. */
const VIEWPORT_LIMIT = 20;
/** The share of a link that must be on screen. */
const VIEWPORT_VISIBLE_RATIO = 0.5;

/** A link in view, or on its way: waiting out its dwell, or in the queue. */
interface Watched {
  /** The page it fetches ahead — none for a link that only loads code. */
  readonly url: string | undefined;
  readonly options: PrefetchOptions;
  /** Loads the code of its target (`<Link preload="viewport">`). */
  readonly preload: (() => Promise<unknown>) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  queued: boolean;
}

/** The links watched in one document, the queue of those that dwelled long enough, and what runs. */
interface Viewport {
  observer: ViewportObserver | undefined;
  readonly watched: Map<Element, Watched>;
  readonly queue: Element[];
  running: number;
  started: number;
  /** The page the count of `started` belongs to (path and query). */
  pageUrl: string | undefined;
  /** Stops listening for the document to become visible again (listening starts with the first link). */
  stopVisible: (() => void) | undefined;
}

/** The parts of an `IntersectionObserver` the viewport prefetch uses. */
interface ViewportObserver {
  observe(element: Element): void;
  unobserve(element: Element): void;
  disconnect(): void;
}

/** What the observer reports of a link. */
interface ViewportEntry {
  readonly target: Element;
  readonly isIntersecting: boolean;
  readonly intersectionRatio: number;
}

/** A prefetched page: its request (under way or done), and until when it may be shown. */
interface Prefetched {
  readonly controller: AbortController;
  readonly page: Promise<PageObject | undefined>;
  expiresAt: number;
  expired(): boolean;
  /** Its request is done (with a page or without). */
  settled: boolean;
}

/** The pages fetched ahead, by URL — a slot of the document: dropped (their requests aborted) when it is left. */
export const PREFETCHED = slot(
  'prefetched',
  () => new LruMap<string, Prefetched>(PREFETCH_LIMIT),
  (pages) => {
    for (const entry of pages.values()) entry.controller.abort();
    pages.clear();
  },
);

/** The links that prefetch when they scroll into view, by element — a slot of the document: dropped when it is left. */
const VIEWPORT = slot(
  'viewport',
  (): Viewport => ({ observer: undefined, watched: new Map(), queue: [], running: 0, started: 0, pageUrl: undefined, stopVisible: undefined }),
  (viewport) => {
    for (const watched of viewport.watched.values()) clearTimeout(watched.timer);
    viewport.observer?.disconnect();
    viewport.observer = undefined;
    viewport.watched.clear();
    viewport.queue.length = 0;
    viewport.running = 0;
    viewport.started = 0;
    viewport.pageUrl = undefined;
    viewport.stopVisible?.();
    viewport.stopVisible = undefined;
  },
);

type PrefetchCore = Pick<FeatureHost, 'navigator' | 'window' | 'page' | 'left' | 'once' | 'send' | 'foreign' | 'document'>;

/** The prefetched pages of one navigator, by URL. */
export class Prefetches {
  readonly #core: PrefetchCore;

  /** @internal */
  constructor(core: PrefetchCore) {
    this.#core = core;
  }

  get #pages(): LruMap<string, Prefetched> {
    return this.#core.document(PREFETCHED);
  }

  get #viewport(): Viewport {
    return this.#core.document(VIEWPORT);
  }

  /** How many prefetched pages are kept (tests). */
  get size(): number {
    return this.#pages.size;
  }

  /**
   * Fetches the page of `url` ahead of its visit (a hovered link): GET only, with `Purpose: prefetch`, so the server can tell
   * and leave out side effects. A visit of the same URL within `cacheFor` shows it without asking again — or waits for it,
   * if it is still under way. No events, no progress bar, no fallback: a prefetch that fails (offline, 5xx, a 409 after a
   * deployment, anything but a page) is forgotten, and the visit asks the server itself.
   */
  prefetch(url: string, options: PrefetchOptions = {}): Promise<void> {
    const plan = this.#plan(url, options);
    if (!plan) return Promise.resolve();
    const { path, key } = plan;
    const existing = this.#pages.peek(key);
    if (existing && !existing.expired()) return existing.page.then(() => undefined);

    const cacheFor = options.cacheFor ?? DEFAULT_PREFETCH_CACHE_FOR;
    const controller = new AbortController();
    const entry: Prefetched = {
      controller,
      page: this.#fetchAhead(path, controller.signal, options.layer === true).then((page) => {
        entry.settled = true;
        // Kept from when it arrived; nothing to keep → the visit asks the server.
        if (page && this.#pages.peek(key) === entry) entry.expiresAt = Date.now() + cacheFor;
        else if (this.#pages.peek(key) === entry) this.#pages.delete(key);
        return page;
      }),
      expiresAt: Infinity,
      expired: () => Date.now() >= entry.expiresAt,
      settled: false,
    };
    this.#pages.set(key, entry);
    return entry.page.then(() => undefined);
  }

  /** What a prefetch of `url` would fetch (its request URL and key) — undefined when it sends nothing, whatever the cache holds. */
  #plan(url: string, options: PrefetchOptions): { path: string; key: string } | undefined {
    const { window, page } = this.#core;
    const target = new URL(url, window.location.href);
    // Never anything but a GET — whatever a caller passes (a form, an action, is no page to fetch ahead) — and never once the
    // document was left, nor from another site.
    const method = (options as { method?: unknown }).method;
    if (this.#core.left || (method !== undefined && String(method).toLowerCase() !== 'get') || target.origin !== window.location.origin) return undefined;
    const { url: path } = buildRequest(target, 'get', options.data);
    if (path === page.url && !options.layer) return undefined;
    // Its visit went already (a press loaded this code, and the click came first): it asks the server itself.
    const visiting = this.#core.navigator.visiting;
    if (visiting && !visiting.async && visiting.url === path) return undefined;
    return { path, key: prefetchKey(path, options.layer === true) };
  }

  /**
   * Prefetches `url` once `element` has been half in view for 250 ms — a link with `prefetch="viewport"`. Returns what stops
   * watching (the link unmounts). Never a flood: at most 2 requests at once and 20 for each displayed page, the rest of the
   * links waits in order; nothing while the document is hidden, with Save-Data or on a 2g connection; a link that leaves the
   * view before its turn drops out. Without an `IntersectionObserver` it does nothing. `preload` loads the code of the link's
   * target the same way (`<Link preload="viewport">`) — it asks the server nothing, and takes its place in the same queue and the
   * same concurrency, but it counts for none of the 20; with no `url` that is all the link does.
   */
  observe(element: Element, url: string | undefined, options: PrefetchOptions = {}, preload?: () => Promise<unknown>): () => void {
    const { window } = this.#core;
    const Observer = window.IntersectionObserver;
    if (this.#core.left || !Observer || (url !== undefined && new URL(url, window.location.href).origin !== window.location.origin)) return () => {};
    if (url === undefined && !preload) return () => {};
    const viewport = this.#viewport;
    this.#forget(element);
    viewport.observer ??= new Observer((entries) => {
      for (const entry of entries) this.#seen(entry);
    }, { threshold: VIEWPORT_VISIBLE_RATIO });
    viewport.pageUrl ??= this.#core.page.url;
    // A link that came into view (or whose dwell ran out) while the tab was hidden: the observer says nothing again until it
    // changes, so when the tab is shown they are watched anew — the observer reports each one as it is now.
    const doc = window.document;
    if (!viewport.stopVisible && doc?.addEventListener) {
      const shown = () => {
        if (doc.visibilityState === 'hidden') return;
        for (const [watching, watched] of viewport.watched) {
          if (watched.queued) continue;
          viewport.observer?.unobserve(watching);
          viewport.observer?.observe(watching);
        }
      };
      doc.addEventListener('visibilitychange', shown);
      viewport.stopVisible = () => doc.removeEventListener?.('visibilitychange', shown);
    }
    viewport.watched.set(element, { url, options, preload, timer: undefined, queued: false });
    viewport.observer.observe(element);
    return () => this.#forget(element);
  }

  /**
   * A page landed. When it is another page than the one the count belongs to, it starts its own 20 — a reload of the same page
   * (a poll, a live update, "load more", a form with errors) does not. The hook fires before the page is set, so this looks one
   * microtask later.
   */
  landed(): void {
    queueMicrotask(() => this.#pump());
  }

  /** Whether nothing should be fetched ahead of a click now: a hidden document, Save-Data, a slow connection. */
  #saving(): boolean {
    const { window } = this.#core;
    // `navigator.connection` is no standard type: Save-Data and the network's speed, where the browser says them.
    const connection = (window as { navigator?: { connection?: { saveData?: boolean; effectiveType?: string } } }).navigator?.connection;
    return window.document?.visibilityState === 'hidden' || connection?.saveData === true || /^(slow-)?2g$/.test(connection?.effectiveType ?? '');
  }

  /** The observer's word on a link: half in view starts its dwell, anything less ends it (or takes it out of the queue). */
  #seen({ target, isIntersecting, intersectionRatio }: ViewportEntry): void {
    const viewport = this.#viewport;
    const watched = viewport.watched.get(target);
    if (!watched) return;
    if (isIntersecting && intersectionRatio >= VIEWPORT_VISIBLE_RATIO) {
      if (watched.timer !== undefined || watched.queued || this.#saving()) return;
      watched.timer = setTimeout(() => {
        watched.timer = undefined;
        if (this.#saving() || !viewport.watched.has(target)) return;
        watched.queued = true;
        viewport.queue.push(target);
        this.#pump();
      }, VIEWPORT_DWELL_MS);
      return;
    }
    clearTimeout(watched.timer);
    watched.timer = undefined;
    this.#dequeue(target, watched);
  }

  #dequeue(element: Element, watched: Watched): void {
    if (!watched.queued) return;
    watched.queued = false;
    const queue = this.#viewport.queue;
    const index = queue.indexOf(element);
    if (index >= 0) queue.splice(index, 1);
  }

  #forget(element: Element): void {
    const viewport = this.#viewport;
    const watched = viewport.watched.get(element);
    if (!watched) return;
    clearTimeout(watched.timer);
    this.#dequeue(element, watched);
    viewport.watched.delete(element);
    viewport.observer?.unobserve(element);
  }

  /** Starts the links in the queue, in order, while the limits allow. */
  #pump(): void {
    const viewport = this.#viewport;
    const shown = this.#core.page.url;
    if (viewport.pageUrl !== shown) {
      viewport.pageUrl = shown;
      viewport.started = 0;
    }
    // Hidden meanwhile (or Save-Data): the queue gives up — a link that comes into view again queues again.
    if (this.#core.left || this.#saving()) {
      for (const element of viewport.queue.splice(0)) {
        const watched = viewport.watched.get(element);
        if (watched) watched.queued = false;
      }
      return;
    }
    // Links that wait for the next page's 20: they keep their place at the front.
    const waiting: Element[] = [];
    while (viewport.running < VIEWPORT_CONCURRENCY) {
      const element = viewport.queue.shift();
      if (!element) break;
      const watched = viewport.watched.get(element);
      if (!watched) continue;
      if (viewport.started >= VIEWPORT_LIMIT && !watched.preload) {
        waiting.push(element);
        continue;
      }
      this.#forget(element);
      // Sends nothing (the page on screen, a page held or under way already, a repeated link): costs no part of the 20. Nor does a
      // code load, which asks the server nothing; with the 20 reached, a link with both still loads its code, and its fetch is dropped.
      const plan = watched.url === undefined ? undefined : this.#plan(watched.url, watched.options);
      const held = plan && this.#pages.peek(plan.key);
      const fetching = plan !== undefined && !(held && !held.expired()) && viewport.started < VIEWPORT_LIMIT;
      if (!fetching && !watched.preload) continue;
      if (fetching) viewport.started++;
      viewport.running++;
      const url = watched.url;
      // A code load that fails is forgotten: the visit loads it itself.
      const loading = Promise.all([fetching && url !== undefined ? this.prefetch(url, watched.options) : undefined, watched.preload?.().catch(() => undefined)]);
      void loading.finally(() => {
        viewport.running = Math.max(0, viewport.running - 1);
        this.#pump();
      });
    }
    viewport.queue.unshift(...waiting);
  }

  /** Whether a prefetch of `url` has its page already (and may still be used) — an instant visit then needs no placeholder. */
  ready(url: string, layer: boolean): boolean {
    const entry = this.#pages.peek(prefetchKey(url, layer));
    return entry !== undefined && entry.settled && !entry.expired() && Number.isFinite(entry.expiresAt);
  }

  /** The prefetched page of `url`, if it may still be used — taken: a later visit asks the server again. */
  take(url: string, layer: boolean): Promise<PageObject | undefined> | undefined {
    const key = prefetchKey(url, layer);
    const entry = this.#pages.peek(key);
    if (!entry) return undefined;
    this.#pages.delete(key);
    return entry.expired() ? undefined : entry.page;
  }

  /** Every prefetched page goes — a write changed what they show, or the document is left. */
  flush(): void {
    PREFETCHED.clear!(this.#pages);
  }

  /** The page of a prefetch — undefined for anything that is not a page to show as it is. */
  async #fetchAhead(url: string, signal: AbortSignal, layer: boolean): Promise<PageObject | undefined> {
    try {
      const headers: Record<string, string> = layer ? { [PURPOSE_HEADER]: 'prefetch', [REGION_HEADER]: 'layer' } : { [PURPOSE_HEADER]: 'prefetch' };
      const response = await this.#core.send(url, { method: 'get', headers, signal });
      // A redirect led to another site: nothing of it is a page of this one.
      if (this.#core.foreign(response)) {
        await response.body?.cancel();
        return undefined;
      }
      // 409 (a new build, signing in or out), 5xx, a 4xx page, not a page: the visit asks again and handles it. Flash
      // messages wait for the page: the prefetch took none — the visit asks, and its answer brings them.
      if (!response.ok || !speaksProtocol(response.headers) || response.headers.get(FLASH_WAITING_HEADER) === 'true') {
        await response.body?.cancel();
        return undefined;
      }
      // A prefetch takes no flash message (the server sends none): nothing of the kind is kept with it either.
      const { page } = takeFlash((await response.json()) as PageObject);
      return this.#core.left || signal.aborted ? undefined : this.#core.once.receive(page);
    } catch {
      return undefined;
    }
  }
}

/** The prefetch of `url` — kept apart for a layer's request (another answer: the layer's, not a page). */
function prefetchKey(url: string, layer: boolean): string {
  return layer ? `layer ${url}` : url;
}

/**
 * Prefetching as a feature: a plain GET visit takes the page fetched ahead (or waits for it), a write drops them all. What it
 * fetched lives in its slot of the document — gone when the document is left (signing out).
 */
export const prefetch = /* @__PURE__ */ defineFeature('prefetch', (host) => {
  const prefetches = new Prefetches(host);
  host.on('write', () => prefetches.flush());
  host.on('page', () => prefetches.landed());
  host.on('start', (visit) => {
    if (!visit.takes) return undefined;
    // An instant visit shows no placeholder for a page that is here already.
    visit.ready = prefetches.ready(visit.url, visit.layer);
    return { page: prefetches.take(visit.url, visit.layer) };
  });
  return prefetches;
}, 2);

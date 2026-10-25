/**
 * Prefetching: a page fetched ahead of its visit (a hovered link) — GET only, `Purpose: prefetch`, in memory only.
 * Used once, by the visit it was fetched for, within its `cacheFor`; dropped when the document is left (signing out) and
 * when a non-GET visit changes what it shows. Its code loads with the first prefetch (`prefetchWith` in `lazy.ts`).
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
    const { window, page } = this.#core;
    const target = new URL(url, window.location.href);
    // Never anything but a GET — whatever a caller passes (a form, an action, is no page to fetch ahead) — and never once the
    // document was left, nor from another site.
    const method = (options as { method?: unknown }).method;
    if (this.#core.left || (method !== undefined && String(method).toLowerCase() !== 'get') || target.origin !== window.location.origin) return Promise.resolve();
    const { url: path } = buildRequest(target, 'get', options.data);
    if (path === page.url && !options.layer) return Promise.resolve();
    // Its visit went already (a press loaded this code, and the click came first): it asks the server itself.
    const visiting = this.#core.navigator.visiting;
    if (visiting && !visiting.async && visiting.url === path) return Promise.resolve();
    const key = prefetchKey(path, options.layer === true);
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
  host.on('start', (visit) => {
    if (!visit.takes) return undefined;
    // An instant visit shows no placeholder for a page that is here already.
    visit.ready = prefetches.ready(visit.url, visit.layer);
    return { page: prefetches.take(visit.url, visit.layer) };
  });
  return prefetches;
}, 2);

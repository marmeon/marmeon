/**
 * The navigator's memory (E36): ONE least-recently-used map — for the pages of history entries (pinned while on screen),
 * the scroll positions and the pages fetched ahead. Everything here lives in this tab's memory only: never in
 * `history.state`, never in any storage.
 */
import type { PageObject } from '../page.ts';
import type { Remembered } from './remember.ts';
import type { KeptRegion, RegionOwner } from './region.ts';

export interface LruOptions<K, V> {
  /** Never evicted while in here (what is on screen) — nor is the entry just set. */
  pinned?: () => ReadonlySet<K>;
  /** The keys used together with `value` — moved up with it (what is beneath a layer stays while the layer does). */
  together?: (value: V) => Iterable<K> | undefined;
}

/** A Map that forgets its least recently set (or gotten) entries beyond `size`. */
export class LruMap<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #size: number;
  readonly #pinned: LruOptions<K, V>['pinned'];
  readonly #together: LruOptions<K, V>['together'];

  constructor(size: number, { pinned, together }: LruOptions<K, V> = {}) {
    this.#size = Math.max(1, size);
    this.#pinned = pinned;
    this.#together = together;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The entry — counted as used. */
  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value) this.set(key, value);
    return value;
  }

  /** The entry without counting it as used. */
  peek(key: K): V | undefined {
    return this.#entries.get(key);
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    // What is used with it is newer than it, so it goes after it.
    for (const along of this.#together?.(value) ?? []) {
      const entry = this.#entries.get(along);
      if (entry === undefined) continue;
      this.#entries.delete(along);
      this.#entries.set(along, entry);
    }
    if (this.#entries.size <= this.#size) return;
    // Never what is pinned — nor the entry just set (it may be going on screen).
    const pinned = this.#pinned?.();
    for (const oldest of [...this.#entries.keys()]) {
      if (this.#entries.size <= this.#size) break;
      if (!pinned?.has(oldest) && oldest !== key) this.#entries.delete(oldest);
    }
  }

  /** Replaces an entry that is there, keeping its place. */
  update(key: K, value: V): void {
    if (this.#entries.has(key)) this.#entries.set(key, value);
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  values(): IterableIterator<V> {
    return this.#entries.values();
  }
}

/**
 * What memory keeps of a history entry: its page (a layer's, for a layer's entry) and the region objects of its islands —
 * one entry of the LRU together. A layer's entry also names the entries beneath it.
 */
export interface CachedEntry {
  readonly page: PageObject;
  readonly regions: Map<string, KeptRegion>;
  /** What the entry's components remembered (E63) — in memory only, gone with the entry. */
  readonly remembered: Remembered;
  /** A layer's entry (E53): the keys of the entries beneath it, the page's first. */
  readonly below?: readonly string[];
  /** It was pushed right over the entry beneath it, in this document: closing it is Back. */
  readonly pushed?: boolean;
}

/**
 * History entries by key, least recently used first out — but never an entry on screen, and a layer's entries beneath
 * count as used with it (the page under a layer stays while the layer does).
 */
export type PageCache = LruMap<string, CachedEntry>;

/** How many pages the in-memory cache keeps by default. */
export const DEFAULT_PAGE_CACHE_SIZE = 20;

export function pageCache(size: number, onScreen: () => ReadonlySet<string>): PageCache {
  return new LruMap(size, { pinned: onScreen, together: (entry) => entry.below });
}

/** A new page object for an entry that is there (props merged in), keeping its regions and its place. */
export function updatePage(cache: PageCache, key: string, page: PageObject): void {
  const cached = cache.peek(key);
  if (cached) cache.update(key, { ...cached, page });
}

/** What memory keeps of an entry besides its page: its islands' region objects and what its components remembered. */
export function keptOf(owner: RegionOwner): Pick<CachedEntry, 'regions' | 'remembered'> {
  return { regions: owner.regions, remembered: owner.remembered };
}

/**
 * The navigator's memory: ONE least-recently-used map — for the pages of history entries (pinned while on screen),
 * the scroll positions and the pages fetched ahead. Everything here lives in this tab's memory only: never in
 * `history.state`, never in any storage.
 */
import type { PageObject } from '../page.ts';

export interface LruOptions<K> {
  /** Never evicted while in here (what is on screen) — nor is the entry just set. */
  pinned?: () => ReadonlySet<K>;
  /** The keys used together with `key` — moved up with it (what is beneath a layer stays while the layer does). */
  together?: (key: K) => Iterable<K> | undefined;
  /** An entry is let go of — evicted or deleted (not on `clear`). */
  forget?: (key: K) => void;
}

/** A Map that forgets its least recently set (or gotten) entries beyond `size`. */
export class LruMap<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #size: number;
  readonly #pinned: LruOptions<K>['pinned'];
  readonly #together: LruOptions<K>['together'];
  readonly #forget: LruOptions<K>['forget'];

  constructor(size: number, { pinned, together, forget }: LruOptions<K> = {}) {
    this.#size = Math.max(1, size);
    this.#pinned = pinned;
    this.#together = together;
    this.#forget = forget;
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
    for (const along of this.#together?.(key) ?? []) {
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
      if (!pinned?.has(oldest) && oldest !== key) this.delete(oldest);
    }
  }

  /** Replaces an entry that is there, keeping its place. */
  update(key: K, value: V): void {
    if (this.#entries.has(key)) this.#entries.set(key, value);
  }

  delete(key: K): void {
    if (this.#entries.delete(key)) this.#forget?.(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  values(): IterableIterator<V> {
    return this.#entries.values();
  }
}

/**
 * What memory keeps of a history entry: its page (a layer's, for a layer's entry). What features keep of it besides — its
 * islands' region objects, remembered state, a layer's place in the stack — lives in the entry's slots (`host.entry`), which
 * the core empties when memory lets go of the entry.
 */
export interface CachedEntry {
  readonly page: PageObject;
}

/**
 * History entries by key, least recently used first out — but never an entry on screen, and the entries an entry is used
 * together with (beneath a layer) count as used with it.
 */
export type PageCache = LruMap<string, CachedEntry>;

/** How many pages the in-memory cache keeps by default. */
export const DEFAULT_PAGE_CACHE_SIZE = 20;

/** A new page object for an entry that is there (props merged in), keeping its place. */
export function updatePage(cache: PageCache, key: string, page: PageObject): void {
  cache.update(key, { page });
}

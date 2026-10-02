/**
 * Scroll restoration: where the window and every `scroll-region` element were scrolled to, per history entry — exact in
 * memory (by key, from the last scroll event), debounced into the entry itself for a reload or a session restore.
 */
import { LruMap } from './cache.ts';
import type { HistoryState } from './history.ts';
import type { NavigatorWindow } from './navigation.ts';

export interface ScrollPosition {
  readonly x: number;
  readonly y: number;
}

/** The attribute that marks a scrolling container whose position Back/Forward restores, like the window's. */
export const SCROLL_REGION_ATTRIBUTE = 'scroll-region';

/** An element that scrolls (a `scroll-region`). */
export interface ScrollRegion {
  scrollLeft: number;
  scrollTop: number;
}

/** Where a page was scrolled to: the window, and its `scroll-region` elements in document order. */
export interface Scroll {
  scroll: ScrollPosition;
  scrollRegions: ScrollPosition[];
}

export const TOP: Scroll = { scroll: { x: 0, y: 0 }, scrollRegions: [] };

/** Scroll positions are written to the history entry this long after scrolling stops (browsers limit `replaceState` calls). */
const SCROLL_SAVE_DELAY = 100;

/** The scroll positions of one navigator's entries, and the debounced save into the entry on screen. */
export class ScrollMemory {
  readonly #window: NavigatorWindow;
  /** Scroll positions by history key — exact to the last scroll event, unlike the (debounced) history entry. */
  readonly #positions = new LruMap<string, Scroll>(100);
  #saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(window: NavigatorWindow) {
    this.#window = window;
  }

  /** Where the window and the scroll regions are scrolled to now. */
  current(): Scroll {
    return {
      scroll: { x: this.#window.scrollX, y: this.#window.scrollY },
      scrollRegions: this.#regions().map((region) => ({ x: region.scrollLeft, y: region.scrollTop })),
    };
  }

  apply({ scroll, scrollRegions }: Scroll): void {
    this.#window.scrollTo(scroll.x, scroll.y);
    this.#regions().forEach((region, index) => {
      const position = scrollRegions[index] ?? TOP.scroll;
      region.scrollLeft = position.x;
      region.scrollTop = position.y;
    });
  }

  /** Where an entry was scrolled to: from memory (exact), else from the entry itself. */
  of(state: HistoryState): Scroll {
    // `regions`: what the scroll regions were called before W5b — an entry of an older document of this tab.
    const legacy = (state as { regions?: readonly ScrollPosition[] }).regions;
    return this.#positions.peek(state.key) ?? { scroll: state.scroll ?? TOP.scroll, scrollRegions: [...(state.scrollRegions ?? legacy ?? [])] };
  }

  /** The position of entry `key` in memory. */
  get(key: string): Scroll | undefined {
    return this.#positions.peek(key);
  }

  set(key: string, position: Scroll): void {
    this.#positions.set(key, position);
  }

  /** Saves into the entry once scrolling stopped — `save` runs then, unless another scroll or {@link cancelSave} came first. */
  saveLater(save: () => void): void {
    this.cancelSave();
    this.#saveTimer = setTimeout(save, SCROLL_SAVE_DELAY);
  }

  /** A save still pending is dropped (it belongs to the entry just left). */
  cancelSave(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
  }

  #regions(): ScrollRegion[] {
    return this.#window.document ? [...this.#window.document.querySelectorAll(`[${SCROLL_REGION_ATTRIBUTE}]`)] : [];
  }
}

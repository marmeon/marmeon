/**
 * The browser history as the navigator writes it (E36): an entry holds where it is — its URL, component, scroll position
 * and the key of its page in memory — never what it showed. Every entry it writes is counted (`index`), so the navigation
 * guard can undo a Back or Forward.
 */
import type { PageObject } from '../page.ts';
import type { NavigatorWindow } from './navigation.ts';
import type { Scroll, ScrollPosition } from './scroll.ts';

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
  /**
   * Where the entry is in the tab's history, counted by this app — what lets the navigation guard (E64) undo a Back or
   * Forward it was not asked about (`history.go(back)`). A position only, like the scroll.
   */
  readonly index?: number;
}

export function isHistoryState(value: unknown): value is HistoryState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.key === 'string' && typeof state.url === 'string' && typeof state.component === 'string' && !('props' in state);
}

/** The history state of a page's entry: where it is — never what it shows (E36). */
export function entry(page: PageObject, key: string, position: Scroll): HistoryState {
  return withPosition({ component: page.component, url: page.url, key, scroll: position.scroll }, position);
}

/** The state with the position — `scrollRegions` only when the page has any (and never the old name, `regions`). */
export function withPosition(state: HistoryState, { scroll, scrollRegions }: Scroll): HistoryState {
  const { scrollRegions: _old, regions: _legacy, ...rest } = state as HistoryState & { regions?: unknown };
  return scrollRegions.length > 0 ? { ...rest, scroll, scrollRegions } : { ...rest, scroll };
}

/** A key for an entry's page in memory. */
export function newKey(): string {
  // Not crypto.randomUUID(): that exists only in secure contexts (not on http://192.168.…).
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Checks the value of one field of a history entry: whether it is a position (never anything a page showed). */
export type PositionCheck = (value: unknown) => boolean;

const isPosition: PositionCheck = (value) => typeof value === 'object' && value !== null && Object.keys(value).length === 2 && typeof (value as ScrollPosition).x === 'number' && typeof (value as ScrollPosition).y === 'number';
const isString: PositionCheck = (value) => typeof value === 'string';

/** The fields of an entry the core writes itself — features register theirs (`field`). */
const POSITIONS: [string, PositionCheck][] = [
  ['component', isString],
  ['url', isString],
  ['key', isString],
  ['index', Number.isInteger],
  ['scroll', isPosition],
  ['scrollRegions', (value) => Array.isArray(value) && value.every(isPosition)],
];

/**
 * Writes the history entries of one navigator — each at its place in the tab's history (`index`). It is the only writer of
 * `history.state`, and it refuses anything that is not a position (E36): a field it does not know, or a value its check
 * rejects, throws in development and is left out in production. So no feature (and no adapter) can put props on disk.
 */
export class HistoryWriter {
  /** Where the current entry is in the tab's history (`HistoryState.index`) — for undoing a Back the guard stops. */
  index = 0;
  readonly #window: NavigatorWindow;
  readonly #fields = new Map(POSITIONS);

  constructor(window: NavigatorWindow) {
    this.#window = window;
  }

  /** A field a feature writes into its entries (a layer's depth and the keys beneath) — `check` says what a position of it is. */
  field(name: string, check: PositionCheck): void {
    this.#fields.set(name, check);
  }

  /** A new history entry — counted (`index`), so the guard can undo a Back to it. */
  push(state: HistoryState, url: string): void {
    this.index += 1;
    this.#window.history.pushState(this.#positions(state), '', url);
  }

  /** The current history entry, rewritten — at its place. */
  replace(state: HistoryState, url: string): void {
    this.#window.history.replaceState(this.#positions(state), '', url);
  }

  /** The state with only its positions — never anything else (E36). */
  #positions(state: HistoryState): HistoryState {
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries({ ...state, index: this.index })) {
      if (value === undefined) continue;
      if (this.#fields.get(name)?.(value)) kept[name] = value;
      // Development only: a bundler replaces `process.env.NODE_ENV`, and a production bundle drops the message.
      else if (process.env.NODE_ENV !== 'production') {
        throw new Error(
          `[bespoke] A history entry holds where it is, never what it showed (E36): "${name}" is ${this.#fields.has(name) ? 'not a position' : 'no field of it'}. ` +
            'Keep what a page showed in memory — a slot of the feature (host.entry, host.document) — and register a position a feature needs with host.history.field().',
        );
      }
    }
    return kept as unknown as HistoryState;
  }
}

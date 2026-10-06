/**
 * The browser history as the navigator writes it (E36): an entry holds where it is — its URL, component, scroll position
 * and the key of its page in memory — never what it showed. Written through the Navigation API (E184: the entry's
 * `navigation.currentEntry.getState()`, `history.state` stays `null`); where the browser has none, the History fallback feature
 * writes it with `pushState`/`replaceState` (`features/history-fallback.ts`, a chunk of its own).
 */
import type { PageObject } from '../page.ts';
import type { NavigatorWindow } from './navigation.ts';
import type { Scroll, ScrollPosition } from './scroll.ts';

/**
 * What a history entry holds — where it is, never what it showed (E36). Browsers write an entry's state (the Navigation
 * API's, or `history.state` in the History fallback) to disk for session restore, and it outlives a sign-out; the page object (its props) lives only in this tab's
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
  ['scroll', isPosition],
  ['scrollRegions', (value) => Array.isArray(value) && value.every(isPosition)],
];

/** The parts of the Navigation API the navigator uses (Chrome 102, Firefox 147, Safari 26.2) — typed here, no DOM lib needed. */
export interface NavigationLike {
  readonly currentEntry: NavigationEntry | null;
  navigate(url: string, options: { state: unknown; history: 'push' | 'replace'; info: unknown }): unknown;
  updateCurrentEntry(options: { state: unknown }): void;
  traverseTo(key: string): unknown;
  /** The navigation under way (its handler runs): the entry it came from — a Back's direction (E185). */
  readonly transition?: { readonly from: NavigationEntry } | null;
  addEventListener(type: 'navigate', listener: (event: Event) => void): void;
  removeEventListener(type: 'navigate', listener: (event: Event) => void): void;
}

/** An entry of the Navigation API: its key (the browser's, kept by a reload and a session restore) and its state. */
export interface NavigationEntry {
  readonly key: string;
  readonly index: number;
  getState(): unknown;
}

/** The parts of a `navigate` event the navigator reads. */
export interface NavigateEvent {
  readonly navigationType: 'push' | 'replace' | 'reload' | 'traverse';
  readonly canIntercept: boolean;
  /** A traversal is cancelable only same-document and with a fresh user activation (or from a script); a push always. */
  readonly cancelable: boolean;
  readonly userInitiated: boolean;
  readonly info: unknown;
  readonly destination: NavigationEntry;
  intercept(options?: { scroll?: 'manual'; focusReset?: 'manual'; handler?: () => unknown }): void;
  preventDefault(): void;
}

/** How an entry is committed — by the Navigation API (the core's), or with `pushState`/`replaceState` (the History fallback's). */
export type Commit = (state: HistoryState, url: string, how: 'push' | 'replace') => void;

/**
 * Writes the history entries of one navigator. It is the only writer of the entries' state, and it refuses anything that is not
 * a position (E36): a field it does not know, or a value its check rejects, throws in development and is left out in production.
 * So no feature (and no adapter) can put props on disk. A feature adds a field — and, with `value`, what it writes into every
 * entry (tab sync: the epoch); nothing wraps the writer.
 */
export class HistoryWriter {
  readonly #window: NavigatorWindow;
  readonly #fields = new Map(POSITIONS);
  readonly #values = new Map<string, (state: HistoryState) => unknown>();
  /**
   * Commits an entry: with the Navigation API (`navigation.navigate` with the navigator's own `info`; the same URL replaced:
   * `updateCurrentEntry`) — the History fallback feature puts its own here where the browser has none. Without either (an
   * adapter that did not attach the fallback, `[bespoke:C13]`), the History API writes it: nothing follows Back/Forward then.
   */
  commit: Commit = (state, url, how) => {
    const { navigation, location, history } = this.#window;
    if (!navigation) history[how === 'push' ? 'pushState' : 'replaceState'](state, '', url);
    else if (how === 'replace' && new URL(url, location.href).href === location.href) navigation.updateCurrentEntry({ state });
    else navigation.navigate(url, { state, history: how, info: OWN });
  };

  constructor(window: NavigatorWindow) {
    this.#window = window;
  }

  /** The state of the current entry — positions only. */
  get state(): unknown {
    const { navigation, history } = this.#window;
    // `history.state` also with the Navigation API: the entry an older client wrote (a reload after an upgrade) keeps its place.
    return navigation?.currentEntry?.getState() ?? history.state;
  }

  /**
   * A field a feature writes into its entries (a layer's depth and the keys beneath, tab sync's epoch) — `check` says what a
   * position of it is; `value`, what to write into every entry (undefined: nothing).
   */
  field(name: string, check: PositionCheck, value?: (state: HistoryState) => unknown): void {
    this.#fields.set(name, check);
    if (value) this.#values.set(name, value);
  }

  /** A new history entry. */
  push(state: HistoryState, url: string): void {
    this.commit(this.#positions(state), url, 'push');
  }

  /** The current history entry, rewritten — at its place. */
  replace(state: HistoryState, url: string): void {
    this.commit(this.#positions(state), url, 'replace');
  }

/** The state with only its positions — never anything else (E36). */
  #positions(state: HistoryState): HistoryState {
    const kept: Record<string, unknown> = {};
    const all: Record<string, unknown> = { ...state };
    for (const [name, value] of this.#values) all[name] = value(state);
    for (const [name, value] of Object.entries(all)) {
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

/** The `info` of the navigations the navigator commits itself — only those (and Back/Forward to its own entries) it intercepts. */
export const OWN = {};

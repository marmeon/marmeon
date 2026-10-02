/**
 * @internal What the navigator shares with the modules around it (Wave 5c): the page on screen, its history entry, memory,
 * the request pipeline — and, while every feature is still wired in statically, the features themselves. The navigator
 * keeps this state here itself, so every module reads it the same way (and compresses alike). Each module names the part it
 * uses (`Pick<NavigatorCore, …>`); the feature host of Wave 5c step 3 grows out of this. Not part of the adapter contract.
 */
import type { FlashMessage, PageObject } from '../page.ts';
import type { PageCache } from './cache.ts';
import type { DocumentChange } from './document-change.ts';
import type { PropLoader } from './deferred.ts';
import type { Visit, VisitCallbacks, VisitEmitter, VisitProgress } from './events.ts';
import type { FlashChannel } from './flash.ts';
import type { Guards, NavigationGuard } from './features/guard.ts';
import type { InstantVisits } from './features/instant.ts';
import type { LayerStack } from './features/layers.ts';
import type { PagePatches } from './features/optimistic.ts';
import type { Prefetches } from './features/prefetch.ts';
import type { BackRevalidation } from './features/revalidate-on-back.ts';
import type { HistoryWriter } from './history.ts';
import type { LayerControl } from './layer.ts';
import type { Navigator, NavigatorWindow, RenderOptions, VisitMethod, VisitOptions } from './navigation.ts';
import type { OnceStore } from './once.ts';
import type { RegionOwner, RegionTransport } from './region.ts';
import type { Scroll, ScrollMemory } from './scroll.ts';

/** What a request sends (the page headers come on top). */
export interface SendInit {
  readonly method: VisitMethod;
  readonly headers: Record<string, string>;
  readonly body?: BodyInit;
  readonly signal: AbortSignal;
}

/** How a response is read: `replace` the entry on a 409, report a 5xx (`failed`), the guards a full load may pass (`consented`). */
export interface ReadOptions {
  readonly replace: boolean;
  readonly failed: boolean;
  readonly consented?: true | readonly NavigationGuard[] | undefined;
}

/** Where a visit's answer goes (see `Navigator.#place`). */
export interface PlaceOptions {
  readonly method: VisitMethod;
  readonly replace: boolean;
  readonly preserveScroll: boolean;
  readonly preserveState: boolean;
  readonly preserveUrl: boolean;
  readonly partial: boolean;
  readonly hash: string;
}

export interface NavigatorCore {
  /** The navigator itself — its public API (and the host of its layers). */
  readonly navigator: Navigator;
  readonly window: NavigatorWindow;
  /** The pages of the history entries, in memory (E36). */
  readonly cache: PageCache;
  readonly scroll: ScrollMemory;
  readonly history: HistoryWriter;
  readonly once: OnceStore;
  readonly flash: FlashChannel;
  /** Flash messages of answers on their way to the screen — fired once what they came with is rendered. */
  readonly inbox: FlashMessage[];
  /** How the islands' regions send their requests. */
  readonly transport: RegionTransport;
  /** The asset version this tab runs. */
  readonly version: string | null;

  /** The page on screen — under the layers, when some are open. */
  readonly page: PageObject;
  /** Its history entry (undefined until the navigator took over the history). */
  readonly key: string | undefined;
  /** Where the islands of the page on screen live. */
  readonly owner: RegionOwner;
  /** The layers on screen, bottom first. */
  readonly layers: readonly LayerControl['layer'][];
  /** This document was left for a full page load: nothing lands any more. */
  readonly left: boolean;
  /** `start()` took over the history. */
  readonly started: boolean;
  /** A page is being swapped in: scroll events belong to no entry, and what lands for the page on screen goes to memory. */
  transitioning: boolean;

  /** The adapter's render — as it is (no flash messages fired, no placeholder ended). */
  render(page: PageObject, options: RenderOptions): Promise<void>;
  /** Renders, then fires what the rendered answer brought (E60). */
  draw(page: PageObject, options: RenderOptions): Promise<void>;
  /** The page of entry `key` as it is shown: with the optimistic patches under way over it. */
  paint(key: string, page: PageObject): PageObject;
  setPage(page: PageObject): void;
  /** Before a full page load: nothing kept in memory survives it. */
  leave(): void;
  emit: VisitEmitter['emit'];

  /** One request with its events (a newer one cancels an older; `async` ones run beside). */
  request(visit: Visit, callbacks: VisitCallbacks, task: (signal: AbortSignal, onProgress: (progress: VisitProgress) => void) => Promise<PageObject | undefined>): Promise<PageObject | undefined>;
  /** Sends with the page headers (version, once props). */
  send(url: string, init: SendInit, onProgress?: (progress: VisitProgress) => void): Promise<Response>;
  /** The page object of a response — undefined when there is none to show (a full load took over, a 5xx). */
  read(response: Response, options: ReadOptions, visit: Visit, callbacks: VisitCallbacks): Promise<PageObject | undefined>;
  /** A page object fetched in the background, silently — undefined for anything else. A 409 still changes the document. */
  fetchPage(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<PageObject | undefined>;
  /** Fires the flash messages that arrived (each once). */
  flushFlash(): void;
  /** A visit — of the page (`from` undefined) or of a layer. */
  visit(from: LayerControl | undefined, url: string, options: VisitOptions): Promise<PageObject | undefined>;
  /** Shows `page` as the page: a new history entry, or the one on screen. */
  show(page: PageObject, history: 'push' | 'replace', options: { preserveScroll: boolean; preserveState: boolean; hash: string }): Promise<PageObject | undefined>;
  /** The entry `key` shows `page` now — the server's answer for an entry not in memory. */
  restorePage(page: PageObject, key: string, position: Scroll): Promise<void>;

  // The features — statically wired until Wave 5c steps 3 and 4 make them pluggable.
  readonly props: PropLoader;
  readonly documentChange: DocumentChange;
  readonly guards: Guards;
  readonly stack: LayerStack;
  readonly patches: PagePatches;
  readonly prefetches: Prefetches;
  readonly instant: InstantVisits;
  readonly back: BackRevalidation;
}

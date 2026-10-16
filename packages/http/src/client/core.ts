/**
 * The feature host's interface: what the navigator shares with the modules around it and with its features — the page on
 * screen, its history entry, memory, the request pipeline, the hooks and the slots the core empties itself. Each core module
 * names the part it uses (`Pick<NavigatorCore, …>`); a feature gets all of it in `setup`.
 */
import type { FlashMessage } from '../page.ts';
import type { PageObject } from '../protocol.ts';
import type { PageCache } from './cache.ts';
import type { ConfirmRequest } from './confirm.ts';
import type { DocumentChange } from './document-change.ts';
import type { PropLoader } from './deferred.ts';
import type { Visit, VisitCallbacks, VisitEmitter, VisitProgress } from './events.ts';
import type { FeatureHook, FeatureHooks, Slot } from './feature.ts';
import type { FlashChannel } from './flash.ts';
import type { NavigationGuard } from './features/guard.ts';
import type { HistoryState, HistoryWriter } from './history.ts';
import type { Layer, LayerControl } from './layer.ts';
import type { Navigator, NavigatorOptions, NavigatorWindow, RenderOptions, VisitMethod, VisitOptions } from './navigation.ts';
import type { OnceStore } from './once.ts';
import type { RegionOwner } from './owner.ts';
import type { ReloadSpec } from './optimistic.ts';
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

/** The hooks that are events: they return nothing, all of them run. */
export type FeatureEvent = 'write' | 'send' | 'unload' | 'started' | 'stopped' | 'stale' | 'draw' | 'page' | 'arrive' | 'popped' | 'deferred' | 'restored';

/** A render as the core's modules ask for it: the page's owner and the features' contributions are filled in. */
export type DrawOptions = Pick<RenderOptions, 'preserveState'> & Partial<RenderOptions>;

export interface FeatureHost {
  /** The navigator itself — its public API. */
  readonly navigator: Navigator;
  readonly window: NavigatorWindow;
  /** What the app passed to the navigator (`revalidateOnBack`, `confirm`, …). */
  readonly options: NavigatorOptions;
  /** The page the document came with, as the server sent it (a deep link's layers) — until the navigator takes over the history. */
  readonly initial: PageObject | undefined;
  /** The pages of the history entries, in memory. */
  readonly cache: PageCache;
  readonly scroll: ScrollMemory;
  /** Writes history entries — and refuses anything that is not a position. */
  readonly history: HistoryWriter;
  /** Once props — a slot of the document. */
  readonly once: OnceStore;
  /** Flash messages — a slot of the document. */
  readonly flash: FlashChannel;
  /** Flash messages of answers on their way to the screen — fired once what they came with is rendered (a slot of the document). */
  readonly inbox: FlashMessage[];
  /** The asset version this tab runs. */
  readonly version: string | null;

  /** The page on screen — under the layers, when some are open. */
  readonly page: PageObject;
  /** Its history entry (undefined until the navigator took over the history). */
  readonly key: string | undefined;
  /** Where the islands of the page on screen live. */
  readonly owner: RegionOwner;
  /** The layers on screen, bottom first (what features contribute to a render). */
  readonly layers: readonly Layer[];
  /** This document was left for a full page load: nothing lands any more. */
  readonly left: boolean;
  /** `start()` took over the history. */
  readonly started: boolean;
  /** A page is being swapped in: scroll events belong to no entry, and what lands for the page on screen goes to memory. */
  transitioning: boolean;

  // -- Hooks and slots ------------------------------------------------------------------------------------------------------

  /** Hooks into the pipeline — in the order the features were registered. Returns the function that takes it out. */
  on<K extends FeatureHook>(name: K, hook: FeatureHooks[K]): () => void;
  /** Runs the hooks of an event. */
  fire<K extends FeatureEvent>(name: K, ...args: Parameters<FeatureHooks[K]>): void;
  /** What entry `key` (default: the page on screen's) keeps in `slot` — created on first use, emptied with the entry. */
  entry<T>(slot: Slot<T>, key?: string): T;
  /** What entry `key` keeps in `slot`, without creating it. */
  peek<T>(slot: Slot<T>, key: string): T | undefined;
  /** Empties what entry `key` keeps — in `slot`, or in all of them (it shows another page now). */
  forget<T>(key: string, slot?: Slot<T>): void;
  /** What this document keeps in `slot` — created on first use, emptied when the document is left. */
  document<T>(slot: Slot<T>): T;

  // -- The core's services --------------------------------------------------------------------------------------------------

  /** The current history entry: the top layer's, or the page's. */
  top(): string;
  /** The owner of entry `key` on screen — `back`: brought back by Back/Forward (what views declare reloads). */
  ownerOf(key: string, back?: boolean): RegionOwner;
  /** What the view `component` declares to reload when Back/Forward shows it from memory — the `declared` hook's. */
  declared(component: string): Promise<ReloadSpec | undefined>;
  /** The unsaved changes on the levels `leaving` takes off the screen — but `ignore`. */
  blocking(leaving: (level: number) => boolean, ignore?: readonly NavigationGuard[]): NavigationGuard[];
  /** Whether a navigation that takes the levels `leaving` off the screen may go — asking, when unsaved changes are on one. */
  mayLeave(leaving: (level: number) => boolean, ignore?: true | readonly NavigationGuard[]): Promise<boolean>;
  /** Asks the user; a failing dialog is a no. */
  ask(request: ConfirmRequest): Promise<boolean>;
  /** The adapter's render — as it is (no flash messages fired, nothing filled in). */
  render(page: PageObject, options: RenderOptions): Promise<void>;
  /** Renders, then fires what the rendered answer brought — with the owner on screen and the features' contributions. */
  draw(page: PageObject, options: DrawOptions): Promise<void>;
  /** The page of entry `key` as it is shown: with what features paint over it (optimistic patches). */
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
  /** Whether a response came from another origin than the page's: nothing of it is read as a page. */
  foreign(response: Response): boolean;
  /** Fires the flash messages that arrived (each once). */
  flushFlash(): void;
  /** What a feature has under way changed (`pending` hook): who follows `navigator.visiting` and `isPending` reads again. */
  pendingChanged(): void;
  /** A visit — of the page (`from` undefined) or of a layer. */
  visit(from: LayerControl | undefined, url: string, options: VisitOptions): Promise<PageObject | undefined>;
  /** Shows `page` as the page: a new history entry, or the one on screen. */
  show(page: PageObject, history: 'push' | 'replace', options: { preserveScroll: boolean; preserveState: boolean; hash: string }): Promise<PageObject | undefined>;
  /** The entry `key` shows `page` now — the server's answer for an entry not in memory. */
  restorePage(page: PageObject, key: string, position: Scroll): Promise<void>;
  /** Back/Forward to an entry of this navigator (the History fallback's popstate comes in here). */
  traverse(state: HistoryState, own: boolean): Promise<void>;
  /** Whether a feature caused the Back/Forward under way itself (a layer closing). */
  own(): boolean;

  /** Props that load in the background (deferred, streamed, reloads) — fixed in the core. */
  readonly props: PropLoader;
  /** Full loads the server asks for (409) — fixed in the core. */
  readonly documentChange: DocumentChange;
}

/** @internal The name the core's own modules know the host by. */
export type NavigatorCore = FeatureHost;

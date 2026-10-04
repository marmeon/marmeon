/**
 * The heart of the UI-free client core (`@bespokecore/http/client`): the Navigator — visits and their pipeline, the browser
 * history and Back/Forward, the request primitives and leaving the document. What it builds on lives next to it (history,
 * cache, scroll, request, events, document-change, deferred); the features (`features/`: layers, guard, prefetch, instant,
 * optimistic patches, actions, islands' requests, revalidateOnBack, …) attach through the feature host (`feature.ts`): hooks
 * into the pipeline, and slots the core empties itself. None is attached by default (Wave 5c): the adapter attaches each where
 * it is used — and the core loads the layers itself when the server answers with one (E71).
 * No UI framework in here — an adapter (`<BespokeApp>` of @bespokecore/react) renders what the navigator hands it.
 */
import { isPageObject, LOCATION_HEADER, PAGE_HEADER, REGION_HEADER, VERSION_HEADER, type DeferredResult, type FlashKey, type FlashMessage, type PageObject, type ValidationErrors } from '../page.ts';
import { DEFAULT_PAGE_CACHE_SIZE, LruMap, type CachedEntry } from './cache.ts';
import { accepted, confirmRequest, DEFAULT_LEAVE_MESSAGE, nativeConfirm, type Confirm, type ConfirmHandler, type NativeDialogs } from './confirm.ts';
import type { DrawOptions, NavigatorCore, PlaceOptions, ReadOptions, SendInit } from './core.ts';
import { PropLoader } from './deferred.ts';
import { DocumentChange } from './document-change.ts';
import { VisitEmitter, type Visit, type VisitCallbacks, type VisitEvent, type VisitEvents, type VisitProgress } from './events.ts';
import { emptySlot, emptySlots, type EntryStack, type Feature, type FeatureHook, type FeatureHooks, type PendingVisit, type Slot, type VisitPart } from './feature.ts';
import type { NavigationGuard } from './features/guard.ts';
import type { InstantVisit } from './features/instant.ts';
import type { DevtoolsGlobal } from './features/devtools.ts';
import type { LayerStack } from './features/layers.ts';
import type { DeclaredRevalidation } from './features/revalidate-on-back.ts';
import { FLASH, INBOX, takeFlash, type FlashListener } from './flash.ts';
import { entry, HistoryWriter, isHistoryState, newKey, withPosition, type HistoryState } from './history.ts';
import type { Layer, LayerControl } from './layer.ts';
import { loadLayers } from './lazy.ts';
import { mergePage, withQueryOf } from './merge.ts';
import { notify } from './notify.ts';
import { ONCE } from './once.ts';
import type { OptimisticUpdate } from './optimistic.ts';
import { applyPatches, listOf, rollBack } from './patches.ts';
import { RegionOwner } from './owner.ts';
import { buildRequest, partialReloadHeaders, untilAborted } from './request.ts';
import { ScrollMemory, TOP, type Scroll, type ScrollRegion } from './scroll.ts';

// The public API that lives in the modules around the navigator — exported from here as before (W5c.2).
export { DEFAULT_PAGE_CACHE_SIZE } from './cache.ts';
export { DEFAULT_LEAVE_MESSAGE } from './confirm.ts';
export { DEFAULT_NEW_VERSION_MESSAGE } from './document-change.ts';
export type { Visit, VisitCallbacks, VisitEvent, VisitEvents, VisitException, VisitProgress, VersionChange } from './events.ts';
export type { NavigationGuard } from './features/guard.ts';
export type { InstantVisit } from './features/instant.ts';
export type { PrefetchOptions } from './features/prefetch.ts';
export type { RevalidateOnBack } from './features/revalidate-on-back.ts';
export { isHistoryState } from './history.ts';
export type { HistoryState } from './history.ts';
export { mergePage } from './merge.ts';
export { xsrfToken } from './request.ts';
export { SCROLL_REGION_ATTRIBUTE } from './scroll.ts';
export type { ScrollPosition, ScrollRegion } from './scroll.ts';

export type VisitMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

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
  /**
   * The route's name: while a write is under way, it is listed in `navigator.submissions` by it (ghost rows); while any visit
   * is under way, `navigator.visiting.name` says it (`usePending(name)`).
   */
  name?: string;
  /**
   * Ask first (E64): `'Remove this link?'`, or with a title, labels or a text to type (`{ message, prompt: 'DELETE' }`). A no
   * sends nothing (the visit ends `cancel`).
   */
  confirm?: Confirm;
  /**
   * Leaves unsaved changes without asking (the navigation guard, E64): `true` past every guard — a form's own submit passes
   * its guard (`useForm(…, { guard })` does), so the others still ask.
   */
  ignoreGuards?: true | readonly NavigationGuard[];
  /**
   * Keep the URL of the page on screen, though the request went elsewhere — "load more" with `data: { cursor }`:
   * the history entry stays the list's URL (replaced, not a new one), so a reload starts it over instead of showing
   * one later page alone.
   */
  preserveUrl?: boolean;
  /**
   * An instant visit (E64): shows the view's placeholder at once — `component`'s `placeholder`, rendered by the adapter with
   * `props` inside the view's layouts — then the page when its answer lands. The real view never renders with these props.
   * Only for a plain GET visit of a page (no partial reload, no layer, not in the background); a page fetched ahead already
   * shows at once instead. The history entry is pushed when the page lands, not before: until then the page on screen is
   * still the one in the address bar — a failed visit shows it again, Back goes where it would have gone.
   */
  instant?: InstantVisit;
}

type WindowEvent = 'popstate' | 'pageshow' | 'scroll' | 'beforeunload';

/** The parts of `window` the navigator uses (a fake one in tests). The optional ones only add features. */
export interface NavigatorWindow {
  readonly history: Pick<History, 'state' | 'pushState' | 'replaceState'> & {
    scrollRestoration?: ScrollRestoration;
    /** Back (`go(-n)`) — closing a layer goes back to the entry beneath. Without it, the entry is replaced. */
    go?(delta: number): void;
    /** How many entries the tab's history has — where a fresh document's entry is (the last). */
    readonly length?: number;
  };
  /** The browser's own dialogs — the default way to ask (E64) when the app brings none (`confirm`). */
  confirm?: NativeDialogs['confirm'];
  prompt?: NativeDialogs['prompt'];
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
    /** Whether the tab is shown — a live stream over HTTP/1.1 connects only while it is (E104). */
    readonly visibilityState?: DocumentVisibilityState;
    addEventListener?(type: 'DOMContentLoaded' | 'visibilitychange' | 'resume', listener: () => void, options?: AddEventListenerOptions): void;
  };
  /** Live hints (W6.10): one stream per document — without it, none. */
  readonly EventSource?: new (url: string) => EventSource;
  /** Tab sync (W8 step 8): the tabs of the browser hear each other's session epoch — without it, a tab checks when it becomes visible. */
  readonly BroadcastChannel?: new (name: string) => BroadcastChannel;
  /** How the document was loaded — its protocol (`nextHopProtocol`): a live stream over HTTP/1.1 waits while the tab is hidden (E104). */
  readonly performance?: Pick<Performance, 'getEntriesByType'>;
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
   * When only these change, `page` is the one on screen already (with `preserveState`): it must not render again. What the
   * layers feature contributes to a render (`extras` hook) — empty without it.
   */
  readonly layers: readonly Layer[];
  /**
   * An instant visit's placeholder (E64): render `page.component`'s placeholder with `page.props` (what the link handed it), inside
   * that view's layouts — not the view itself, and not as the page (`usePage()` stays the page on screen). A view without a
   * placeholder: nothing changes. A later render replaces it — one that resolves after a later render started is dropped.
   */
  readonly placeholder?: boolean;
}

export interface NavigatorOptions {
  /** The page the server rendered (from `#bespoke-page`) — always fresh: a full load asks the server. */
  initialPage: PageObject;
  /**
   * Shows a page: resolve its component and render it. Resolves once it is on screen (scroll restores after that).
   * `owner` is where the page's regions (islands) live — its history entry's memory: the adapter hands it to
   * `navigator.use(islands).region(url, { owner })`, so an island loads into the entry it is rendered for.
   */
  render: (page: PageObject, options: RenderOptions) => Promise<void>;
  /** Default: the browser's `window`. */
  window?: NavigatorWindow;
  /** Pages kept in memory, one per history entry; the least recently shown goes first. Default 20. */
  cacheSize?: number;
  /**
   * What a view declares to reload when Back/Forward shows it from memory (E58) — the adapter reads it from the view
   * (`Show.revalidateOnBack = ['notifications']`): `true` all its props, a list some of them, nothing (the default) none. Read by
   * the `revalidateOnBack` feature — attach it (`navigator.use(revalidateOnBack)`).
   * The page (or layer, or island) shows from memory at once; then those props load in the background, without a progress bar.
   */
  revalidateOnBack?: DeclaredRevalidation;
  /**
   * Asks the user (E64): a confirmation (`confirm` of a visit or an action) or the navigation guard's question. Default: the
   * browser's own `confirm()` (and `prompt()` to type a text). The answer of a type-to-confirm question is the text typed —
   * the core compares it.
   */
  confirm?: ConfirmHandler;
  /**
   * The features to attach from the start (E70) — default: none. An adapter attaches each where it is used
   * (`navigator.use(feature)`, or `navigator.load(loader)` on first use, E74).
   */
  features?: readonly Feature[] | undefined;
  /**
   * How the layers load when the server answers with one and nothing attached them yet (E71) — default {@link loadLayers},
   * the core's chunk. An adapter loads its own layer UI with it, in the same round trip (React: the layer stack). Then use the
   * same loader where layers open (`navigator.load(…)` for `<Link layer>`), so the navigator knows it is loaded.
   */
  loadLayers?: () => Promise<Feature<LayerStack>>;
}

/** The core while the navigator builds it: what is made after it joins it once. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** The hooks of the features, by name. */
type Hooks = { [K in FeatureHook]?: FeatureHooks[K][] };

/** What `slots` keeps in `slot` — created on first use. */
function held<T>(slots: Map<Slot<unknown>, unknown>, slot: Slot<T>): T {
  if (!slots.has(slot)) slots.set(slot, slot.create());
  return slots.get(slot) as T;
}

/**
 * Navigates without full page loads: a visit fetches the next page object as JSON (`x-bespoke`), keeps it
 * in memory and pushes a history entry *without* its props. Back and Forward show the page from memory —
 * or ask the server when it is not there — and restore where it was scrolled to. A `409` with
 * `x-bespoke-location` (a new build, or signing in or out — `ClientHistory` on the server) loads that URL
 * fully and drops every page kept in memory. Every request reports its events (`on('start', …)`).
 */
export class Navigator {
  /**
   * What the navigator shares with the modules around it and with its features (`FeatureHost`): the page on screen, its
   * entry, memory, the hooks and slots — kept there, so every module reads them the same way. First, so minifiers give it
   * the same short name in each class.
   */
  readonly #core: Writable<NavigatorCore>;
  readonly #render: NavigatorOptions['render'];
  readonly #events = new VisitEmitter();
  #inFlight: AbortController | undefined;
  /** Requests in the background (`visit.async`): they die with the document's pages when it is left. */
  readonly #background = new Set<AbortController>();
  /** Who follows the page on screen (`subscribe`) — query state, say. */
  readonly #pageListeners = new Set<(page: PageObject) => void>();
  /** The visit under way in the foreground (not in the background) — `data-pending`, `usePending` (E64). */
  #visiting: Visit | undefined;
  readonly #visitingListeners = new Set<() => void>();
  /** The features attached (`use`), with what their setup returned. */
  readonly #features = new Map<Feature, unknown>();
  /** Their hooks, by name — in the features' order (`Feature.order`), then in the order they were attached. */
  readonly #hooks: Hooks = {};
  /** The order of the feature each hook belongs to. */
  readonly #orders = new WeakMap<object, number>();
  /** The order of the feature whose setup runs (`use`) — a hook registered outside a setup comes last. */
  #order = Infinity;
  /** The features loaded on first use (`load`), by their loader — attached from then on without waiting. */
  readonly #loaded = new Map<() => Promise<Feature>, Feature>();
  /** The layers' code on its way (E71) — whether it loaded. */
  #layersLoading: Promise<boolean> | undefined;
  /** What the history entries keep in slots, by key — emptied when memory lets go of an entry, and when the document is left. */
  readonly #entries = new Map<string, Map<Slot<unknown>, unknown>>();
  /** What the document keeps in slots — emptied when it is left. */
  readonly #document = new Map<Slot<unknown>, unknown>();

  constructor(options: NavigatorOptions) {
    const { initialPage, render, window: win = globalThis.window, cacheSize = DEFAULT_PAGE_CACHE_SIZE, features = [] } = options;
    this.#render = render;
    const ask = options.confirm ?? nativeConfirm(win);
    const nav = this;
    const core = {
      navigator: this as Navigator,
      window: win,
      options,
      initial: initialPage,
      // One entry per history entry — never one on screen, and what an entry is used together with (beneath a layer) stays with it.
      cache: new LruMap<string, CachedEntry>(cacheSize, {
        pinned: () => new Set([core.key!, ...this.#all('pinned').flat()]),
        together: (key) => [...(this.#entries.get(key) ?? [])].flatMap(([slot, value]) => [...(slot.along?.(value) ?? [])]),
        forget: (key) => core.forget(key),
      }),
      scroll: new ScrollMemory(win),
      history: new HistoryWriter(win),
      get once() {
        return core.document(ONCE);
      },
      get flash() {
        return core.document(FLASH);
      },
      get inbox() {
        return core.document(INBOX);
      },
      key: undefined as string | undefined,
      left: false,
      started: false,
      transitioning: false,
      get layers(): readonly Layer[] {
        return nav.#extras().layers ?? [];
      },
      on: (name, hook) => {
        // A new list each time: a hook loop under way (a visit waiting for its guard's answer) runs the hooks it started with.
        const hooks = (this.#hooks[name] ?? []) as object[];
        const order = this.#order;
        this.#orders.set(hook, order);
        let at = hooks.length;
        while (at > 0 && this.#orders.get(hooks[at - 1]!)! > order) at--;
        this.#hooks[name] = [...hooks.slice(0, at), hook, ...hooks.slice(at)] as never;
        return () => void (this.#hooks[name] = (this.#hooks[name] as object[] | undefined)?.filter((other) => other !== hook) as never);
      },
      fire: (name, ...args) => void this.#all(name, ...args),
      entry: (slot, key = core.key!) => {
        let slots = this.#entries.get(key);
        if (!slots) this.#entries.set(key, (slots = new Map()));
        return held(slots, slot);
      },
      peek: (slot, key) => this.#entries.get(key)?.get(slot) as never,
      forget: (key, slot) => {
        const slots = this.#entries.get(key);
        if (slot) {
          if (slots?.has(slot)) emptySlot(slot, slots.get(slot) as never);
          slots?.delete(slot);
        } else if (slots) {
          emptySlots(slots);
          this.#entries.delete(key);
        }
      },
      document: (slot) => held(this.#document, slot),
      top: () => this.#first('top') ?? core.key!,
      ownerOf: (key, back) => new RegionOwner(key, back),
      declared: (component) => this.#first('declared', component) ?? Promise.resolve(undefined),
      blocking: (leaving, ignore = []) => this.#all('unsaved', leaving, ignore).flat(),
      mayLeave: async (leaving, ignore) => {
        if (ignore === true) return true;
        const blocking = core.blocking(leaving, ignore);
        return blocking.length === 0 || core.ask({ kind: 'leave', message: blocking[0]!.message ?? DEFAULT_LEAVE_MESSAGE });
      },
      ask: async (request) => {
        try {
          return accepted(request, await ask(request));
        } catch {
          return false;
        }
      },
      render: (page, renderOptions) => this.#render(page, renderOptions),
      draw: (page, drawOptions) => this.#draw(page, drawOptions),
      paint: (key, page) => (this.#hooks.paint ?? []).reduce((shown, paint) => paint(key, shown), page),
      setPage: (page) => this.#setPage(page),
      leave: () => this.#leave(),
      emit: this.#events.emit.bind(this.#events),
      request: (visit, callbacks, task) => this.#request(visit, callbacks, task),
      send: (url, init, onProgress) => this.#send(url, init, onProgress),
      read: (response, readOptions, visit, callbacks) => this.#read(response, readOptions, visit, callbacks),
      fetchPage: (url, headers, signal) => this.#fetchPage(url, headers, signal),
      flushFlash: () => this.#flushFlash(),
      pendingChanged: () => notify(this.#visitingListeners),
      visit: (from, url, visitOptions) => this.#visit(from, url, visitOptions),
      show: (page, history, showOptions) => this.#show(page, history, showOptions),
      restorePage: (page, key, position) => this.#restorePage(page, key, position),
    } satisfies Partial<NavigatorCore> as Partial<Writable<NavigatorCore>> as Writable<NavigatorCore>;
    this.#core = core;
    core.version = initialPage.version ?? null;
    core.documentChange = new DocumentChange(core);
    // What the adapter attaches from the start (a deep link's layers take theirs from `initial`, until the history is taken over).
    for (const feature of features) this.use(feature);
    // The first page's flash messages (E60) fire once the app has started — never kept with the page.
    const { layers: _layers, ...withFlash } = initialPage;
    const page = this.#collect(withFlash);
    core.page = page;
    core.props = new PropLoader(core, page, initialPage.streamedProps ?? []);
    // Development only (W7 step 9): the devtools' bar attaches to the navigator (`__BESPOKE_DEVTOOLS_HOOK__`, set by its client,
    // which the Vite dev server alone serves) — a production build drops this line.
    if (process.env.NODE_ENV !== 'production') (globalThis as DevtoolsGlobal).__BESPOKE_DEVTOOLS_HOOK__?.navigator?.(this);
  }

  /**
   * Attaches a feature (E70): its setup runs once per navigator — the first call — and what it returned comes back on every
   * call. What adapters use of a feature they get from here (`useFeature(islands)` in React).
   */
  use<API>(feature: Feature<API>): API {
    if (!this.#features.has(feature)) {
      const outer = this.#order;
      this.#order = feature.order ?? Infinity;
      try {
        this.#features.set(feature, feature.setup(this.#core));
      } finally {
        this.#order = outer;
      }
    }
    return this.#features.get(feature) as API;
  }

  /**
   * Attaches a feature whose code loads on first use (E74) — `navigator.load(loadLiveValidation)`: its chunk is fetched once,
   * then it is attached like `use` (idempotent). Rejects when the chunk cannot load (offline, gone after a deployment).
   */
  async load<API>(loader: () => Promise<Feature<API>>): Promise<API> {
    const feature = await loader();
    this.#loaded.set(loader, feature);
    return this.use(feature);
  }

  /**
   * A feature `load` loaded already — attached, its API at once (no waiting for a promise: what a hovered link does next must
   * happen before the click it leads to); undefined before.
   */
  loaded<API>(loader: () => Promise<Feature<API>>): API | undefined {
    const feature = this.#loaded.get(loader);
    return feature && this.use(feature as Feature<API>);
  }

  /** The page on screen — under the layers, when some are open. */
  get page(): PageObject {
    return this.#core.page;
  }

  /** The layers on screen over the page, bottom first (E53). */
  get layers(): readonly Layer[] {
    this.#adopt();
    return this.#core.layers;
  }

  /** How many pages are kept in memory (tests). */
  get cachedPages(): number {
    return this.#core.cache.size;
  }

  /** Where the regions of the page on screen live — for the adapter's first page (later ones come with `render`). */
  get regionOwner(): RegionOwner {
    this.#adopt();
    return this.#core.owner;
  }

  /**
   * A deferred group of the first page, as the server streamed it with the document (E49) — `null` when it did not
   * arrive (it failed on the server, or the adapter rendered its part in the browser): then it is asked for, as without
   * streaming. It lands once the document has finished streaming: an update of the page while an island of it is still
   * streaming would make the adapter render that island in the browser — and load it again.
   */
  async receiveStreamed(group: string, streamed: DeferredResult | null): Promise<void> {
    this.#adopt();
    await this.#core.props.receiveStreamed(group, streamed);
  }

  /**
   * Takes over the history (Back/Forward, scroll restoration, the back/forward cache). Returns the function
   * that stops it.
   */
  start(): () => void {
    const core = this.#core;
    const restored = this.#adopt();
    // The navigator restores scroll positions itself — the browser's would apply before the page is rendered.
    if (core.window.history.scrollRestoration !== undefined) core.window.history.scrollRestoration = 'manual';
    // A reload or a session restore keeps the entry: back to where it was.
    if (restored) core.scroll.apply(core.scroll.of(restored));
    // The first render is on screen — now the props it was sent without (the layers' too).
    core.props.load();
    this.#all('deferred');
    core.window.addEventListener('popstate', this.#onPopState);
    core.window.addEventListener('pageshow', this.#onPageShow);
    // Capturing: scroll events of elements do not bubble, but pass the window on their way down.
    core.window.addEventListener('scroll', this.#onScroll, { capture: true, passive: true });
    core.started = true;
    this.#all('started');
    // The first page's flash messages (E60): on screen now.
    this.#flushFlash();
    return () => {
      core.started = false;
      core.window.removeEventListener('popstate', this.#onPopState);
      core.window.removeEventListener('pageshow', this.#onPageShow);
      core.window.removeEventListener('scroll', this.#onScroll, { capture: true });
      this.#all('stopped');
      core.scroll.cancelSave();
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
   * Listens to the events of every request (a progress bar, logging) — and to the flash messages answers deliver
   * (`on('flash', …)`, E60). Returns the function that stops listening.
   */
  on<E extends VisitEvent>(event: E, listener: VisitEvents[E]): () => void {
    if (event === 'flash') return this.#core.flash.listen(listener as FlashListener);
    return this.#events.on(event as Exclude<E, 'flash'>, listener as VisitEvents[Exclude<E, 'flash'>]);
  }

  /**
   * The flash messages of one key (E60) — each once, from now on, and those nobody heard yet at once: `useFlash('toast', …)`.
   * Returns the function that stops listening.
   */
  onFlash(key: FlashKey, listener: (message: FlashMessage) => void): () => void {
    return this.#core.flash.listen(listener, key);
  }

  /** The visit under way in the foreground, or undefined (E64: `data-pending`, `usePending`). */
  get visiting(): Visit | undefined {
    return this.#visiting;
  }

  /** Follows {@link visiting} — and {@link isPending}. Returns the function that stops it. */
  subscribeVisiting(listener: () => void): () => void {
    this.#visitingListeners.add(listener);
    return () => void this.#visitingListeners.delete(listener);
  }

  /**
   * Whether a request of route `name` is under way — a visit (`<Link route>`, a route form) or what a feature has under way
   * (an action, when the actions feature is attached) — E64, `usePending`.
   */
  isPending(name: string): boolean {
    return this.#visiting?.name === name || this.#first('pending', name) === true;
  }

  /**
   * Asks the user (E64) — what `confirm` of a visit or an action does: resolves with yes or no. A type-to-confirm question
   * (`prompt`) is a yes only when exactly that text was typed.
   */
  confirm(confirm: Confirm): Promise<boolean> {
    return this.#core.ask(confirmRequest(confirm));
  }

  /** Whether a guard would ask before leaving now (unsaved changes anywhere on screen — `navigator.use(guard).add(…)`). */
  isGuarded(): boolean {
    return this.#core.blocking(() => true).length > 0;
  }

  // -- The core ---------------------------------------------------------------------------------------------------------

  /**
   * The current page again from the server (fresh props), keeping scroll position and component state. `data`
   * goes into the query string — `reload({ data: { cursor }, only: ['people'], preserveUrl: true })` loads more.
   */
  reload(options: Omit<VisitOptions, 'method'> = {}): Promise<PageObject | undefined> {
    // The page's URL — not the window's: under a layer, the window shows the layer's.
    return this.visit(this.#core.page.url, { replace: true, preserveScroll: true, preserveState: true, ...options });
  }

  /** Where a postponed new build loads (E64) — undefined while none is waiting. For "a new version is available". */
  get newVersion(): string | undefined {
    return this.#core.documentChange.newVersion;
  }

  /** Follows {@link newVersion}. Returns the function that stops it. */
  subscribeNewVersion(listener: () => void): () => void {
    return this.#core.documentChange.subscribe(listener);
  }

  /** Loads the new build now — a full load of the page on screen (or where the postponed one was going). */
  reloadForNewVersion(): void {
    this.#core.documentChange.reloadNow();
  }

  /**
   * Resolves with the page the visit ended on — undefined if it did not end on a page: the browser took over,
   * a newer visit replaced it (`onCancel`), or it failed (`onException`). It never rejects for a failed request.
   */
  async visit(url: string, options: VisitOptions = {}): Promise<PageObject | undefined> {
    return this.#visit(undefined, url, options);
  }

  // -- The hooks of the features ------------------------------------------------------------------------------------------

  /** What every hook `name` returns, in order — an event's (all run). */
  #all<K extends FeatureHook>(name: K, ...args: Parameters<FeatureHooks[K]>): ReturnType<FeatureHooks[K]>[] {
    return (this.#hooks[name] ?? []).map((hook) => (hook as (...args: unknown[]) => ReturnType<FeatureHooks[K]>)(...args));
  }

  /** The first result of hook `name` that is not undefined — a pipeline hook's (the feature that takes it). */
  #first<K extends FeatureHook>(name: K, ...args: Parameters<FeatureHooks[K]>): Exclude<ReturnType<FeatureHooks[K]>, void> | undefined {
    for (const hook of this.#hooks[name] ?? []) {
      const result = (hook as (...args: unknown[]) => unknown)(...args);
      if (result !== undefined) return result as Exclude<ReturnType<FeatureHooks[K]>, void>;
    }
    return undefined;
  }

  /** What the features contribute to a render (the layers on screen). */
  #extras(): Partial<RenderOptions> {
    return Object.assign({}, ...this.#all('extras'));
  }

  // -- The visit pipeline -----------------------------------------------------------------------------------------------

  /**
   * A visit — of the page (`from` undefined) or of a layer over it. Where its answer goes: a page replaces the page (and
   * the layers go) — unless a feature takes it (a layer's answer opens over the level it came from, a reload of the page under
   * the layers lands there); a layer's request that the server answers with `closeLayer()` closes it.
   */
  async #visit(from: LayerControl | undefined, url: string, options: VisitOptions): Promise<PageObject | undefined> {
    this.#adopt();
    const core = this.#core;
    const { method = 'get', data, replace = false, preserveScroll = false, headers = {}, async: background = false, preserveUrl = false } = options;
    const preserveState = options.preserveState ?? method !== 'get';

    const target = new URL(url, core.window.location.href);
    const current = from ? from.layer.page : core.page;
    // A partial reload names the page (or layer) it reloads: the server sends only some props when it renders that one.
    const partial = options.only !== undefined || (options.except?.length ?? 0) > 0 ? current.component : undefined;
    // The levels it takes off the screen: the page and every layer — or, opening a layer, those over where it opens. A visit that
    // keeps what is on screen (in the background, a partial reload, "load more", a reload of the same page) takes none.
    const level = from ? from.layer.depth : 0;
    const keeps = background || preserveUrl || partial !== undefined || (preserveState && target.pathname + target.search === current.url);
    const pending: PendingVisit = {
      options,
      method,
      target,
      from,
      layer: from !== undefined || options.layer === true,
      keeps,
      leaving: (at) => (options.layer === true ? at > level : at >= level),
      url: '',
      partial: partial !== undefined,
      takes: false,
    };
    // Its own confirmation first (E64) — the core asks, whatever features are attached: a no sends nothing.
    if (options.confirm !== undefined && !(await core.ask(confirmRequest(options.confirm)))) return undefined;
    // A feature may stop it (E64: unsaved changes) — asking only when one is concerned: otherwise it starts at once (in the
    // same task).
    for (const hook of this.#hooks.visit ?? []) {
      let go = hook(pending);
      if (go instanceof Promise) go = await go;
      if (go === false) return undefined;
    }
    if (target.origin !== core.window.location.origin) {
      // Another site: the browser goes there. Visits only ever read answers of this one.
      this.#all('unload');
      this.#away(target.href);
      return undefined;
    }
    // A new build was postponed (E64): the user's next visit (a GET — a form is never thrown away) loads its page fully. One
    // that would have kept the page (a partial reload) asks first when unsaved changes are on screen.
    if (core.documentChange.newVersion !== undefined && !background && method === 'get') {
      if (keeps && options.ignoreGuards !== true && !(await core.mayLeave(() => true, options.ignoreGuards))) return undefined;
      this.#all('unload');
      this.#away(target.href);
      return undefined;
    }
    // What a full load the server asks for (a new build) would lose that this visit was allowed to leave already (E64).
    const consented = options.ignoreGuards === true || (!keeps && level === 0 && options.layer !== true) ? true : options.ignoreGuards;
    // A write changes what pages fetched ahead show: none of them is used after it.
    if (method !== 'get') this.#all('write');

    const request = buildRequest(target, method, data);
    pending.url = request.url;
    // A layer's request (E53): sent as one — and the layers' code, when it is not here yet, loads beside it (E71).
    if (pending.layer) {
      request.headers[REGION_HEADER] = 'layer';
      void this.#layers(true);
    }
    // A plain GET visit — it may take a page fetched ahead (or wait for its request, still under way).
    pending.takes = method === 'get' && partial === undefined && Object.keys(headers).length === 0;
    // What the features add to it: a page fetched ahead, an instant visit's placeholder (E64), a form's ghost row (E59).
    const parts = this.#all('start', pending).filter(Boolean) as VisitPart[];
    // A form's optimistic patches (E59) — of the page, a layer or an island: shown while it is under way. The core applies them,
    // whatever is attached: each target keeps its own (the page's are the optimistic feature's, attached where they are made).
    const patched = applyPatches(listOf(options.optimistic));
    const prefetched = parts.find((part) => part.page)?.page;
    const named = options.name !== undefined ? { name: options.name } : {};
    const visit: Visit = background ? { url: request.url, method, async: true, ...named } : { url: request.url, method, ...named };
    // An async visit lands only on the page (or the layer) it started from.
    const fromKey = core.key;
    try {
      return await this.#request(visit, options, async (signal, onProgress) => {
        for (const part of parts) part.sending?.(signal);
        let page = prefetched ? await untilAborted(prefetched, signal) : undefined;
        if (!page) {
          if (signal.aborted) return undefined;
          const response = await this.#send(
            request.url,
            { method, headers: { ...request.headers, ...Object.assign({}, ...parts.map((part) => part.headers)), ...(partial === undefined ? {} : partialReloadHeaders(partial, options.only, options.except)), ...headers }, body: request.body, signal },
            onProgress,
          );
          // Left meanwhile (a 409 of a request in the background: signed out): the answer is not read — nothing of it is taken.
          if (signal.aborted) return undefined;
          // What answers a layer's request — a layer, its close — needs the layers' code (E71).
          if (pending.layer && !(await this.#needLayers(signal, request.url))) return undefined;
          const answered = this.#first('response', response, pending, visit);
          if (answered) return answered;
          page = await this.#read(response, { replace, failed: true, consented }, visit, options);
        }
        if (!page || signal.aborted) return undefined;
        // The server answered with a layer (E53: it may, to any visit) and nothing loaded the layers yet (E71): their code
        // first — never shown as a page, never dropped.
        if (page.layer && !(await this.#needLayers(signal, page.url))) return undefined;
        if (background && (core.left || core.key !== fromKey || core.transitioning || from?.layer.closed)) return undefined;
        // The answer replaces what the parts and the patches showed — in the same render (the server's props then, or its errors).
        for (const part of parts) part.landed?.();
        for (const [target, ids] of patched) target.settle(ids, false, { quiet: true });
        // Some props of the same page (or layer): into the ones it has. (Another page — a redirect to the login — came in full.)
        if (partial !== undefined && page.component === partial && current.component === partial) page = mergePage(current, page, options.reset);
        // The URL — and so the query state — stays the one of the page on screen.
        if (preserveUrl) page = withQueryOf({ ...page, url: current.url }, current);
        const shown = await this.#place(from, page, { method, replace, preserveScroll, preserveState, preserveUrl, partial: partial !== undefined, hash: preserveUrl ? '' : target.hash });
        if (shown) {
          const errors = validationErrors(shown);
          if (errors) this.#events.emit('error', options.onError, errors, visit);
          else this.#events.emit('success', options.onSuccess, shown, visit);
        }
        return shown;
      });
    } finally {
      // Failed, cancelled, or the browser took over: nothing of the parts stays (the placeholder gone), the patches roll back.
      for (const part of parts.reverse()) part.end?.();
      rollBack(patched);
    }
  }

  /** Where a visit's answer goes — see {@link Navigator.#visit}: a feature takes it (layers), anything else is the page. */
  async #place(from: LayerControl | undefined, page: PageObject, options: PlaceOptions): Promise<PageObject | undefined> {
    const placed = this.#first('place', from, page, options);
    if (placed) return placed;
    const { method, replace, preserveScroll, preserveState, preserveUrl, hash } = options;
    // Redirected back to the same URL (a failed form), or kept the URL ("load more"): replace, don't stack history entries.
    const sameUrl = page.url === this.#core.window.location.pathname + this.#core.window.location.search;
    const history = replace || preserveUrl || (method !== 'get' && sameUrl) ? 'replace' : 'push';
    return this.#show(page, history, { preserveScroll, preserveState, hash });
  }

  /**
   * The entry the document was loaded into gets a key, and its page goes into the cache — with the layers it came with (a
   * deep link): the page under them has no entry of its own then, the entry is the top layer's. Returns a restored entry.
   */
  #adopt(): HistoryState | undefined {
    const core = this.#core;
    if (core.key !== undefined) return undefined;
    const state: unknown = core.window.history.state;
    // A reload or session restore keeps the entry's key (and scroll); the page itself came fresh from the server.
    const restored = isHistoryState(state) ? state : undefined;
    // Where the entry is: kept by a reload or a session restore, else the last (a fresh load pushes its entry at the end).
    core.history.index = typeof restored?.index === 'number' ? restored.index : Math.max(0, (core.window.history.length ?? 1) - 1);
    const key = restored?.key ?? newKey();
    const position = restored ? core.scroll.of(restored) : TOP;
    // A deep link (a layer's URL): the layers take the entry — the page under them gets a key of its own, in memory only.
    const pageKey = this.#first('adopt', key, position) ?? key;
    if (process.env.NODE_ENV !== 'production' && pageKey === key && core.initial?.layers?.length) {
      console.warn(
        '[bespoke:C8] The document is a layer’s URL (a deep link, a reload), but the layers were not attached before the navigator took over the history — ' +
          'the page beneath shows without them. Attach them before the first render: await navigator.load(loadLayers) (createBespokeApp does).',
      );
    }
    core.initial = undefined;
    core.key = pageKey;
    core.owner = core.ownerOf(pageKey);
    core.props.adopt(pageKey, core.page);
    core.cache.set(pageKey, { page: core.page });
    if (pageKey === key) core.history.replace(entry(core.page, key, position), core.window.location.href);
    return restored;
  }

  async #show(
    page: PageObject,
    history: 'push' | 'replace',
    { preserveScroll, preserveState, hash }: { preserveScroll: boolean; preserveState: boolean; hash: string },
  ): Promise<PageObject | undefined> {
    const core = this.#core;
    // Under an instant visit's placeholder (E64), the page being left was scrolled where it was before it showed.
    const leaving = this.#first('position') ?? core.scroll.current();
    core.scroll.cancelSave();
    core.transitioning = true;
    const keep = preserveState && page.component === core.page.component;
    // The entry being left (or replaced): the top layer's, when layers are open — a page replaces them too (E53).
    const top = core.top();
    // The entry the page goes into: a new one, or the one on screen (then its optimistic patches still show over the answer).
    const key = history === 'push' ? newKey() : top;
    // The page's islands: those of the page on screen when its state is kept (the same component — a partial reload, a
    // sort link): replaced in place, they stay; pushed, the new entry starts with a copy. Any other page starts empty — an
    // entry replaced by it forgets what it kept.
    let owner = core.owner;
    if (history === 'push' || !keep || top !== core.key) {
      if (history === 'replace') core.forget(key);
      owner = core.ownerOf(key);
      if (keep) this.#all('carry', core.owner, owner);
    }
    try {
      try {
        await this.#draw(core.paint(key, page), { preserveState, owner, layers: [] });
      } catch {
        // The page's code could not be loaded (a chunk gone after a deployment, offline): the browser loads it.
        if (owner !== core.owner) owner.close();
        this.#away(page.url);
        return undefined;
      }
      const arrived = preserveScroll ? core.scroll.current() : TOP;
      if (history === 'push') {
        // Remember where the page being left was scrolled to — Back restores it.
        core.scroll.set(top, leaving);
        core.history.replace(this.#first('state', top, leaving) ?? entry(core.page, top, leaving), core.window.location.href);
      }
      core.key = key;
      core.history[history](entry(page, key, arrived), page.url + hash);
      this.#all('page');
      core.scroll.set(key, arrived);
      core.cache.set(key, { page });
      this.#switchOwner(owner);
      this.#setPage(page);
      if (!preserveScroll) core.scroll.apply(TOP);
      if (hash) core.window.document?.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
      core.props.load();
      return page;
    } finally {
      core.transitioning = false;
    }
  }

  // -- Back/Forward -----------------------------------------------------------------------------------------------------

  readonly #onPopState = (event: Event): void => {
    const state: unknown = (event as PopStateEvent).state;
    // `null`: an entry of a fragment link (`#section`) on the same page.
    if (state === null || state === undefined) return;
    const core = this.#core;
    if (isHistoryState(state) && state.layer) {
      const loading = this.#layers();
      if (loading !== true) {
        // A layer's entry, and the layers' code is not here (the document was loaded since, E71): it loads first, then the
        // entry is followed — unless Back/Forward went on meanwhile. The visit under way is left, as by any Back.
        this.#inFlight?.abort();
        void loading.then((loaded) => {
          const now: unknown = core.window.history.state;
          if (core.left || !isHistoryState(now) || now.key !== state.key) return;
          if (loaded) this.#onPopState(event);
          // Like a page's code that cannot load: the browser loads the entry.
          else this.#away();
        });
        return;
      }
    }
    // A popstate a feature caused itself (a layer closing by going back): the visit that caused it is not cancelled by it.
    const own = this.#first('own') === true;
    // A feature takes it (E64: the guard's own popstate, or a Back/Forward it stops); others follow it (an instant visit ends).
    if (this.#first('popState', state, own)) return;
    if (isHistoryState(state) && typeof state.index === 'number') core.history.index = state.index;
    if (!own) this.#inFlight?.abort();
    // A save still pending belongs to the entry just left; the browser already switched to the new one.
    core.scroll.cancelSave();
    if (isHistoryState(state)) {
      const stack = this.#first('stack', state.key) ?? (core.cache.get(state.key) && { page: state.key });
      if (stack) {
        void this.#arriveAt(state, stack, own);
        return;
      }
      this.#all('popped');
      if (!this.#first('restore', state)) void this.#restore(state.url, state.key, core.scroll.of(state));
      return;
    }
    this.#all('popped');
    // An entry of an older client, which kept whole pages in the history: never shown — the server is asked.
    if (isPageObject(state)) void this.#restore(state.url, newKey(), TOP);
  };

  /**
   * Back/Forward to an entry in memory: its page and what features put over it (layers). When it is the page on screen (a
   * layer closed by Back, opened again by Forward), only what is over it changes — the page is not rendered again, does not
   * scroll, and none of its deferred props or islands load again.
   */
  async #arriveAt(state: HistoryState, stack: EntryStack, own: boolean): Promise<void> {
    const core = this.#core;
    try {
      if (stack.page === core.key && !core.left) {
        await this.#first('rearrange', stack, own);
        return;
      }
      this.#all('page');
      const base = core.cache.peek(stack.page)!;
      core.key = stack.page;
      // The entry's islands come back with it, from memory — no request (but what their views declare reloads, E58).
      const owner = core.ownerOf(stack.page, true);
      this.#switchOwner(owner);
      this.#setPage(base.page);
      this.#all('arrive', stack);
      await this.#arrive(base.page, core.scroll.of(state), owner);
      // Shown from memory at once — then what the views declare reloads in the background (E58).
      if (!own && core.key === stack.page) this.#all('restored', base.page, stack.page);
    } finally {
      this.#all('popped');
    }
  }

  /** Renders a page of the history and scrolls to where it was. */
  async #arrive(page: PageObject, position: Scroll, owner: RegionOwner): Promise<void> {
    const core = this.#core;
    core.transitioning = true;
    try {
      await this.#draw(core.paint(core.key!, page), { preserveState: false, owner });
      core.scroll.apply(position);
      core.props.load();
      this.#all('deferred');
    } catch {
      this.#away();
    } finally {
      core.transitioning = false;
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
        this.#away();
        return undefined;
      }
      if (signal.aborted) return undefined;
      // An error page is what this URL shows now — like a full load would.
      const page = await this.#read(response, { replace: true, failed: false }, visit, {});
      if (!page || signal.aborted) return undefined;
      // Signed out meanwhile? Then the server sent the login page — and the entry is the login page now.
      await this.#restorePage(page, key, position);
      return page;
    });
  }

  /** The entry `key` shows `page` now (the server's answer for an entry not in memory — a page where a layer was, too). */
  async #restorePage(page: PageObject, key: string, position: Scroll): Promise<void> {
    const core = this.#core;
    core.history.replace(entry(page, key, position), page.url);
    this.#all('page');
    core.key = key;
    core.forget(key);
    const owner = core.ownerOf(key);
    core.cache.set(key, { page });
    this.#switchOwner(owner);
    this.#setPage(page);
    await this.#arrive(page, position, owner);
  }

  readonly #onPageShow = (event: Event): void => {
    // Back into this document from the back/forward cache, after it was left for a full page load (signing
    // out, say): what it still shows may not be for whoever is here now. Ask the server.
    if ((event as PageTransitionEvent).persisted && this.#core.left) this.#core.window.location.reload();
  };

  readonly #onScroll = (): void => {
    const core = this.#core;
    if (core.transitioning || core.key === undefined) return;
    core.scroll.set(core.key, core.scroll.current());
    // Into the entry too, for a reload or a session restore — debounced: browsers throttle replaceState.
    core.scroll.saveLater(() => {
      const key = core.key;
      const state: unknown = core.window.history.state;
      if (core.transitioning || key === undefined || !isHistoryState(state) || state.key !== key) return;
      const position = core.scroll.get(key);
      if (position) core.history.replace(withPosition(state, position), core.window.location.href);
    });
  };

  // -- Requests ---------------------------------------------------------------------------------------------------------

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
    const events = this.#events;
    const controller = new AbortController();
    if (visit.async) {
      this.#background.add(controller);
    } else {
      this.#inFlight?.abort();
      this.#inFlight = controller;
      this.#setVisiting(visit);
    }
    events.emit('start', callbacks.onStart, visit);
    try {
      const page = await task(controller.signal, (progress) => events.emit('progress', callbacks.onProgress, progress, visit));
      if (controller.signal.aborted) events.emit('cancel', callbacks.onCancel, visit);
      return page;
    } catch (cause) {
      if (controller.signal.aborted) events.emit('cancel', callbacks.onCancel, visit);
      else events.emit('exception', callbacks.onException, { type: 'network', visit, cause });
      return undefined;
    } finally {
      if (this.#inFlight === controller) this.#inFlight = undefined;
      if (this.#visiting === visit) this.#setVisiting(undefined);
      this.#background.delete(controller);
      // Messages of an answer that did not land (moved on meanwhile, a failure page): they were taken — they fire anyway.
      this.#flushFlash();
      events.emit('finish', callbacks.onFinish, visit);
    }
  }

  /**
   * The page object of a response — or undefined when there is none to show: a full page load took over
   * (409, a response that is not a page), or the server failed (5xx, reported as an `error` when `failed`).
   */
  async #read(response: Response, { replace, failed, consented }: ReadOptions, visit: Visit, callbacks: VisitCallbacks): Promise<PageObject | undefined> {
    if (response.status === 409 && response.headers.has(LOCATION_HEADER)) {
      // A new build, or signing in or out: load the page fully. The pages in memory go with this document.
      await this.#core.documentChange.change(response, replace ? 'replace' : 'assign', consented);
      return undefined;
    }
    const isPage = response.headers.get(PAGE_HEADER) === 'true';
    if (failed && response.status >= 500) {
      // The page stays (and whatever was typed into it); the app shows the server's error as a fallback.
      const page = isPage ? this.#collect((await response.json()) as PageObject) : undefined;
      const html = isPage ? undefined : await response.text();
      this.#events.emit('exception', callbacks.onException, { type: 'server', visit, status: response.status, page, html });
      return undefined;
    }
    if (!isPage) {
      // Not a page (e.g. a 401 JSON or a file download): let the browser handle it.
      this.#away(response.url || new URL(visit.url, this.#core.window.location.href).href);
      return undefined;
    }
    return this.#collect((await response.json()) as PageObject);
  }

  /**
   * Sends a request with the page headers — through XHR for `FormData` with a progress listener (upload progress): its code loads
   * with the first such upload (a chunk of its own); one that cannot load sends it with `fetch`, without progress.
   */
  #send(url: string, { method, headers, body, signal }: SendInit, onProgress?: (progress: VisitProgress) => void): Promise<Response> {
    const init = {
      method: method.toUpperCase(),
      // The once props held (E64): the server does not compute them again.
      headers: { [PAGE_HEADER]: 'true', ...(this.#core.version ? { [VERSION_HEADER]: this.#core.version } : {}), ...this.#core.once.headers(), ...headers },
      body,
      signal,
    };
    const Xhr = this.#core.window.XMLHttpRequest;
    if (body instanceof FormData && onProgress && Xhr) {
      return import('./upload.ts').then(({ sendWithProgress }) => sendWithProgress(Xhr, url, init, onProgress), () => this.#core.window.fetch(url, init));
    }
    return this.#core.window.fetch(url, init);
  }

  /**
   * A page object fetched in the background — undefined for anything else (offline, a 4xx/5xx, not a page). Silent: no
   * events. A 409 with a location still changes the document (signed out, a new build).
   */
  async #fetchPage(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<PageObject | undefined> {
    if (this.#core.left) return undefined;
    const controller = new AbortController();
    this.#background.add(controller);
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      const response = await this.#send(url, { method: 'get', headers, signal: combined });
      if (this.#core.left || combined.aborted) {
        await response.body?.cancel();
        return undefined;
      }
      if (response.status === 409 && response.headers.has(LOCATION_HEADER)) {
        await this.#core.documentChange.change(response, 'assign');
        return undefined;
      }
      if (!response.ok || response.headers.get(PAGE_HEADER) !== 'true') {
        await response.body?.cancel();
        return undefined;
      }
      return this.#collect((await response.json()) as PageObject);
    } catch {
      return undefined;
    } finally {
      this.#background.delete(controller);
    }
  }

  // -- The page on screen, flash messages (E60), pending visits (E64) ---------------------------------------------------

  #setPage(page: PageObject): void {
    this.#core.page = page;
    notify(this.#pageListeners, page);
  }

  /** The page on screen now belongs to `owner`'s entry: the regions of the one before stop (their requests are aborted). */
  #switchOwner(owner: RegionOwner): void {
    if (owner === this.#core.owner) return;
    this.#core.owner.close();
    this.#core.owner = owner;
  }

  /** The page without its flash messages — they go into the inbox, fired once the page (or what it came with) is on screen. */
  #collect(page: PageObject): PageObject {
    // It follows live channels (W6.10): the core attaches the live feature — server-driven, like the layers (E71); once there, it
    // follows the screen itself. A chunk that cannot load: no hints (the page works without them).
    if (page.live) import('./features/live.ts').then((module) => this.use(module.live), () => {});
    const { page: rest, flash } = takeFlash(page);
    if (flash.length > 0) this.#core.inbox.push(...flash);
    // Once props (E64): kept when they came, put back when the server skipped them (they are held).
    return this.#core.once.receive(rest);
  }

  /** Fires the flash messages that arrived (each once). */
  #flushFlash(): void {
    if (this.#core.inbox.length === 0 || this.#core.left) return;
    this.#core.flash.deliver(this.#core.inbox.splice(0));
  }

  /**
   * Renders — the owner on screen and what the features contribute (the layers) filled in — then fires what the rendered answer
   * brought (E60): the page's layout shows a toast over the new page, not the old.
   */
  async #draw(page: PageObject, options: DrawOptions): Promise<void> {
    this.#all('draw');
    await this.#render(page, { owner: this.#core.owner, layers: [], ...this.#extras(), ...options });
    this.#flushFlash();
  }

  #setVisiting(visit: Visit | undefined): void {
    if (this.#visiting === visit) return;
    this.#visiting = visit;
    notify(this.#visitingListeners);
  }

  /** Whether a feature named `name` is attached — by name: a wrapped one (a test's) counts too. */
  #has(name: string): boolean {
    for (const feature of this.#features.keys()) if (feature.name === name) return true;
    return false;
  }

  /**
   * The layers' code (E71): attached already (`true`) — or loading now, the first time the server answers with a layer (or
   * Back/Forward goes to a layer's entry, or a layer's request is sent: `asked`) and nothing here loaded it before. Resolves with
   * whether it loaded: not, offline or gone after a deployment (asked for again next time).
   */
  #layers(asked = false): true | Promise<boolean> {
    if (this.#has('layers')) return true;
    return (this.#layersLoading ??= this.#loadLayers(asked));
  }

  async #loadLayers(asked: boolean): Promise<boolean> {
    // Development: a layer nobody here asked for — the server's answer, or Back/Forward.
    if (process.env.NODE_ENV !== 'production' && !asked) {
      console.info(
        '[bespoke:C7] The server answered with a layer (or Back/Forward went to one), but no code here had loaded the layers yet — loading them now, one round trip. ' +
          'Open layers with <Link layer> or visit(url, { layer: true }) to load them before.',
      );
    }
    try {
      await this.load(this.#core.options.loadLayers ?? loadLayers);
      return true;
    } catch {
      return false;
    } finally {
      this.#layersLoading = undefined;
    }
  }

  /**
   * What a visit's answer needs: the layers' code (E71) — false when the answer is dropped: the visit moved on meanwhile (a
   * newer one, Back), the document was left (a 409), or the code cannot load — then the browser loads `url` (a layer's URL
   * loads with what is beneath it), like a page whose code cannot load: never a half state.
   */
  #needLayers(signal: AbortSignal, url: string): true | Promise<boolean> {
    const loading = this.#layers();
    return (
      loading === true ||
      loading.then((loaded) => {
        if (signal.aborted || this.#core.left) return false;
        if (!loaded) this.#away(url);
        return loaded;
      })
    );
  }

  /** Leaves the document (see {@link #leave}): the browser loads `url` — or, without one, the entry it is on. */
  #away(url?: string): void {
    this.#leave();
    if (url === undefined) this.#core.window.location.reload();
    else this.#core.window.location.assign(url);
  }

  /**
   * Before a full page load: nothing kept in memory survives it, should the browser bring this document back. What the
   * features keep is in their slots — emptied here, whichever feature it is: remembered state, once props, flash messages
   * waiting, optimistic patches, actions under way, layers, islands, pages fetched ahead.
   */
  #leave(): void {
    const core = this.#core;
    core.left = true;
    for (const slots of this.#entries.values()) emptySlots(slots);
    this.#entries.clear();
    emptySlots(this.#document);
    // The islands of the page on screen: none of them lands any more (signing out).
    core.owner?.close();
    core.cache.clear();
    // Nothing under way comes back into a page of someone who has left (signed out): not a deferred prop still loading, not
    // the visit the user started before — its answer is what the signed-in user was about to see.
    for (const request of this.#background) request.abort();
    this.#inFlight?.abort();
  }
}

/** The validation errors a page carries (the shared `errors` prop), or undefined when there are none. */
function validationErrors(page: PageObject): ValidationErrors | undefined {
  const errors = (page.props as { errors?: unknown }).errors;
  return typeof errors === 'object' && errors !== null && Object.keys(errors).length > 0 ? (errors as ValidationErrors) : undefined;
}

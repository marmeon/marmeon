/**
 * The heart of the UI-free client core (`@bespokecore/http/client`): the Navigator — visits and their pipeline, the browser
 * history and Back/Forward, the request primitives and leaving the document. What it builds on lives next to it (history,
 * cache, scroll, request, events, document-change, deferred), each feature in `features/` (layers, guard, prefetch, instant,
 * optimistic patches, islands' requests, actions' host, revalidateOnBack) — still wired in here statically.
 * No UI framework in here — an adapter (`<BespokeApp>` of @bespokecore/react) renders what the navigator hands it.
 */
import { isPageObject, LAYER_CLOSE_HEADER, LOCATION_HEADER, MAX_LAYER_DEPTH, PAGE_HEADER, REGION_HEADER, VERSION_HEADER, type DeferredResult, type FlashKey, type FlashMessage, type LayerClose, type PageObject, type ValidationErrors } from '../page.ts';
import { Actions, applyPatches, rollBack, Submissions, type ActionHost, type ActionOptions, type ActionOutcome, type Submission } from './action.ts';
import { keptOf, pageCache, DEFAULT_PAGE_CACHE_SIZE } from './cache.ts';
import { confirmRequest, nativeConfirm, type Confirm, type ConfirmHandler, type NativeDialogs } from './confirm.ts';
import type { NavigatorCore, PlaceOptions, ReadOptions, SendInit } from './core.ts';
import { PropLoader } from './deferred.ts';
import { DocumentChange } from './document-change.ts';
import { VisitEmitter, type Visit, type VisitCallbacks, type VisitEvent, type VisitEvents, type VisitProgress } from './events.ts';
import { actionHost } from './features/actions.ts';
import { Guards, type NavigationGuard } from './features/guard.ts';
import { InstantVisits, type InstantShown, type InstantVisit } from './features/instant.ts';
import { regionTransport } from './features/islands.ts';
import { LayerStack, type CachedStack, type PendingClose } from './features/layers.ts';
import { PagePatches } from './features/optimistic.ts';
import { Prefetches, untilAborted, type PrefetchOptions } from './features/prefetch.ts';
import { BackRevalidation, type DeclaredRevalidation } from './features/revalidate-on-back.ts';
import { FlashChannel, takeFlash, type FlashListener } from './flash.ts';
import { entry, HistoryWriter, isHistoryState, newKey, withPosition, type HistoryState } from './history.ts';
import type { Layer, LayerControl, LayerHost } from './layer.ts';
import { LiveValidation, sendLiveValidation, type LiveValidationOptions, type LiveValidationOutcome, type LiveValidationRequest } from './live-validation.ts';
import { mergePage, withQueryOf } from './merge.ts';
import { notify } from './notify.ts';
import { OnceStore } from './once.ts';
import { listOf, type OptimisticUpdate, type PropsPatch, type Reloading, type ReloadSpec } from './optimistic.ts';
import { QueryState, type QueryStateOptions } from './query-state.ts';
import { RegionOwner, type Region, type RegionInitial } from './region.ts';
import { buildRequest, partialReloadHeaders, sendWithProgress } from './request.ts';
import { ScrollMemory, TOP, type Scroll, type ScrollRegion } from './scroll.ts';

// The public API that lives in the modules around the navigator — exported from here as before (W5c.2).
export { DEFAULT_PAGE_CACHE_SIZE } from './cache.ts';
export { DEFAULT_NEW_VERSION_MESSAGE } from './document-change.ts';
export type { Visit, VisitCallbacks, VisitEvent, VisitEvents, VisitException, VisitProgress, VersionChange } from './events.ts';
export { DEFAULT_LEAVE_MESSAGE } from './features/guard.ts';
export type { NavigationGuard } from './features/guard.ts';
export type { InstantVisit } from './features/instant.ts';
export { DEFAULT_PREFETCH_CACHE_FOR } from './features/prefetch.ts';
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
    addEventListener?(type: 'DOMContentLoaded', listener: () => void, options?: AddEventListenerOptions): void;
  };
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
   * When only these change, `page` is the one on screen already (with `preserveState`): it must not render again.
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
   * `navigator.region(url, { owner })`, so an island loads into the entry it is rendered for.
   */
  render: (page: PageObject, options: RenderOptions) => Promise<void>;
  /** Default: the browser's `window`. */
  window?: NavigatorWindow;
  /** Pages kept in memory, one per history entry; the least recently shown goes first. Default 20. */
  cacheSize?: number;
  /**
   * What a view declares to reload when Back/Forward shows it from memory (E58) — the adapter reads it from the view
   * (`Show.revalidateOnBack = ['notifications']`): `true` all its props, a list some of them, nothing (the default) none.
   * The page (or layer, or island) shows from memory at once; then those props load in the background, without a progress bar.
   */
  revalidateOnBack?: DeclaredRevalidation;
  /**
   * Asks the user (E64): a confirmation (`confirm` of a visit or an action) or the navigation guard's question. Default: the
   * browser's own `confirm()` (and `prompt()` to type a text). The answer of a type-to-confirm question is the text typed —
   * the core compares it.
   */
  confirm?: ConfirmHandler;
}

/** The core while the navigator builds it: what is made after it joins it once. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Navigates without full page loads: a visit fetches the next page object as JSON (`x-bespoke`), keeps it
 * in memory and pushes a history entry *without* its props. Back and Forward show the page from memory —
 * or ask the server when it is not there — and restore where it was scrolled to. A `409` with
 * `x-bespoke-location` (a new build, or signing in or out — `ClientHistory` on the server) loads that URL
 * fully and drops every page kept in memory. Every request reports its events (`on('start', …)`).
 */
export class Navigator implements LayerHost {
  /**
   * What the navigator shares with the modules around it (`NavigatorCore`): the page on screen, its entry, memory, the
   * features — kept there, so every module reads them the same way. First, so minifiers give it the same short name in each class.
   */
  readonly #core: Writable<NavigatorCore>;
  readonly #render: NavigatorOptions['render'];
  readonly #events = new VisitEmitter();
  #inFlight: AbortController | undefined;
  /** Requests in the background (`visit.async`): they die with the document's pages when it is left. */
  readonly #background = new Set<AbortController>();
  /** Who follows the page on screen (`subscribe`) — query state, say. */
  readonly #pageListeners = new Set<(page: PageObject) => void>();
  /** Actions and route forms under way — what ghost rows are made of (E59). */
  readonly #submissions = new Submissions();
  readonly #actions: Actions;
  readonly #actionHost: ActionHost;
  /** The visit under way in the foreground (not in the background) — `data-pending`, `usePending` (E64). */
  #visiting: Visit | undefined;
  readonly #visitingListeners = new Set<() => void>();

  constructor({ initialPage, render, window: win = globalThis.window, cacheSize = DEFAULT_PAGE_CACHE_SIZE, revalidateOnBack, confirm }: NavigatorOptions) {
    this.#render = render;
    const core = {
      navigator: this as Navigator,
      window: win,
      cache: pageCache(cacheSize, () => core.stack.onScreen()),
      scroll: new ScrollMemory(win),
      history: new HistoryWriter(win),
      once: new OnceStore(),
      flash: new FlashChannel(),
      inbox: [] as FlashMessage[],
      key: undefined as string | undefined,
      left: false,
      started: false,
      transitioning: false,
      get layers() {
        return core.stack.list;
      },
      render: (page, options) => this.#render(page, options),
      draw: (page, options) => this.#draw(page, options),
      paint: (key, page) => core.patches.paint(key, page),
      setPage: (page) => this.#setPage(page),
      leave: () => this.#leave(),
      emit: this.#events.emit.bind(this.#events),
      request: (visit, callbacks, task) => this.#request(visit, callbacks, task),
      send: (url, init, onProgress) => this.#send(url, init, onProgress),
      read: (response, options, visit, callbacks) => this.#read(response, options, visit, callbacks),
      fetchPage: (url, headers, signal) => this.#fetchPage(url, headers, signal),
      flushFlash: () => this.#flushFlash(),
      visit: (from, url, options) => this.#visit(from, url, options),
      show: (page, history, options) => this.#show(page, history, options),
      restorePage: (page, key, position) => this.#restorePage(page, key, position),
    } satisfies Partial<NavigatorCore> as Partial<Writable<NavigatorCore>> as Writable<NavigatorCore>;
    this.#core = core;
    core.version = initialPage.version ?? null;
    core.transport = regionTransport(core);
    core.guards = new Guards(core, confirm ?? nativeConfirm(win));
    core.documentChange = new DocumentChange(core);
    core.prefetches = new Prefetches(core);
    core.instant = new InstantVisits(core);
    core.patches = new PagePatches(core);
    core.back = new BackRevalidation(core, revalidateOnBack);
    this.#actionHost = actionHost(core);
    this.#actions = new Actions(this.#actionHost, this.#submissions);
    // A deep link of a layer's URL: the page under it (its base, or the neutral surface), the layers apart.
    const { layers: initialLayers, ...withFlash } = initialPage;
    core.stack = new LayerStack(
      core,
      (initialLayers ?? []).slice(0, MAX_LAYER_DEPTH).map((layer) => core.once.receive(takeFlash(layer).page)),
    );
    // The first page's flash messages (E60) fire once the app has started — never kept with the page.
    const page = this.#collect(withFlash);
    core.page = page;
    core.owner = new RegionOwner(core.transport);
    core.props = new PropLoader(core, page, initialPage.streamedProps ?? []);
  }

  /** The page on screen — under the layers, when some are open. */
  get page(): PageObject {
    return this.#core.page;
  }

  /** The layers on screen over the page, bottom first (E53). */
  get layers(): readonly Layer[] {
    this.#adopt();
    return this.#core.stack.list;
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
   * A region of the page — an island (E48, E50): `url` is its route's (same origin), `owner` the entry it belongs to (what
   * `render` handed the adapter; default: the page on screen). The same URL gives the same region (one request for two
   * identical islands); what it loaded stays in the entry's memory, so Back/Forward shows it without a request. `initial`
   * is a region object the server already sent (streamed with the page). Islands never load ahead (no prefetch, E52).
   */
  region(url: string, { owner, initial }: { owner?: RegionOwner; initial?: RegionInitial } = {}): Region {
    this.#adopt();
    const target = new URL(url, this.#core.window.location.href);
    if (target.origin !== this.#core.window.location.origin) throw new Error(`A region comes from this site, not from ${target.origin} (${url}).`);
    return (owner ?? this.#core.owner).region(target.pathname + target.search, initial);
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
    const restored = this.#adopt();
    // The navigator restores scroll positions itself — the browser's would apply before the page is rendered.
    if (this.#core.window.history.scrollRestoration !== undefined) this.#core.window.history.scrollRestoration = 'manual';
    // A reload or a session restore keeps the entry: back to where it was.
    if (restored) this.#core.scroll.apply(this.#core.scroll.of(restored));
    // The first render is on screen — now the props it was sent without (the layers' too).
    this.#core.props.load();
    this.#core.stack.loadAllDeferred();
    this.#core.window.addEventListener('popstate', this.#onPopState);
    this.#core.window.addEventListener('pageshow', this.#onPageShow);
    // Capturing: scroll events of elements do not bubble, but pass the window on their way down.
    this.#core.window.addEventListener('scroll', this.#onScroll, { capture: true, passive: true });
    this.#core.started = true;
    this.#core.guards.start();
    // The first page's flash messages (E60): on screen now.
    this.#flushFlash();
    return () => {
      this.#core.started = false;
      this.#core.window.removeEventListener('popstate', this.#onPopState);
      this.#core.window.removeEventListener('pageshow', this.#onPageShow);
      this.#core.window.removeEventListener('scroll', this.#onScroll, { capture: true });
      this.#core.guards.stop();
      this.#core.scroll.cancelSave();
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
   * Typed URL state of the page on screen (E55): its query, parsed by the server (`PageObject.query`), changed with
   * visits of the same page — debounced, partial, keeping state and scroll. See {@link QueryState}.
   */
  queryState<Q extends Record<string, unknown> = Record<string, unknown>>(options: QueryStateOptions = {}): QueryState<Q> {
    return new QueryState<Q>(this, options);
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

  /** Follows {@link visiting}. Returns the function that stops it. */
  subscribeVisiting(listener: () => void): () => void {
    this.#visitingListeners.add(listener);
    return () => void this.#visitingListeners.delete(listener);
  }

  /** Whether a request of route `name` is under way — a visit (`<Link route>`, a route form) or an action (E64, `usePending`). */
  isPending(name: string): boolean {
    return this.#visiting?.name === name || this.#submissions.list.some((submission) => submission.name === name);
  }

  /**
   * Asks the user (E64) — what `confirm` of a visit or an action does: resolves with yes or no. A type-to-confirm question
   * (`prompt`) is a yes only when exactly that text was typed.
   */
  async confirm(confirm: Confirm): Promise<boolean> {
    return this.#core.guards.question(confirmRequest(confirm));
  }

  /**
   * Guards unsaved changes (E64): from now on — while `guard.active()` says so — a visit, Back/Forward or closing its layer asks
   * first (`guard.message`), and closing the tab or reloading asks with the browser's own question. Returns the function that
   * lifts it. A form passes its own guard when it is sent (`ignoreGuards`); a full page load the server asks for (a 409:
   * signed out, a new build) is never stopped.
   */
  guard(guard: NavigationGuard): () => void {
    return this.#core.guards.add(guard);
  }

  /** Whether a guard would ask before leaving now (unsaved changes anywhere on screen). */
  isGuarded(): boolean {
    return this.#core.guards.blocking(() => true).length > 0;
  }

  /**
   * An action (E59): a request that does not navigate — no history entry, nothing in the page cache, no progress bar. Its
   * optimistic patches show at once and are rolled back unless it succeeds; when it does, `reload` reloads what it names in
   * the background and its patches go once the server's props landed. Resolves with how it ended — never rejects for a
   * failed request (an `exception`: shown by the app, never retried by itself).
   */
  action(url: string, options: ActionOptions = {}): Promise<ActionOutcome> {
    this.#adopt();
    return this.#actions.run(url, options);
  }

  /**
   * A live validation (E62): checks `fields` of a form's data against the request schema of the route at `url` — sent as the form
   * would be (method, body, XSRF) with `x-bespoke-validate`, minus password fields and files. Never navigates, never listed as a
   * submission, never changes what was fetched ahead. Resolves with how it ended — never rejects for a failed request.
   */
  validate(url: string, request: LiveValidationRequest): Promise<LiveValidationOutcome> {
    return sendLiveValidation(this.#actionHost, url, request);
  }

  /** The live validation of one form at `url` (E62): touched fields, debounce, the check under way — see {@link LiveValidation}. */
  liveValidation(url: string, options: Omit<LiveValidationOptions, 'send'>): LiveValidation {
    return new LiveValidation({ ...options, send: (request) => this.validate(url, request) });
  }

  /** Actions and route forms under way, oldest first — what ghost rows are made of (E59 model 2). A new array on each change. */
  get submissions(): readonly Submission[] {
    return this.#submissions.list;
  }

  /** Follows {@link submissions}. Returns the function that stops it. */
  subscribeSubmissions(listener: () => void): () => void {
    return this.#submissions.subscribe(listener);
  }

  /**
   * A patch of the props of the page on screen (E59), for an action or a form: `optimistic((props) => ({ likes: props.likes + 1 }))`
   * — shown over the props in memory while the action is under way, never written into them before it succeeded.
   */
  optimistic(patch: PropsPatch): OptimisticUpdate {
    this.#adopt();
    return { target: this.#core.patches.target(this.#core.key!), patch };
  }

  /** A reload of the page on screen for an action to run once it succeeded — some props (`only`), or all of them. */
  reloading(spec: ReloadSpec = {}): Reloading {
    this.#adopt();
    return { target: this.#core.patches.target(this.#core.key!), spec };
  }

  /**
   * Resolves with the page the visit ended on — undefined if it did not end on a page: the browser took over,
   * a newer visit replaced it (`onCancel`), or it failed (`onException`). It never rejects for a failed request.
   */
  async visit(url: string, options: VisitOptions = {}): Promise<PageObject | undefined> {
    return this.#visit(undefined, url, options);
  }

  /** A visit from inside a layer (E53) — `layer.visit()`: sent as the layer's, its answer placed for it. */
  layerVisit(layer: Layer, url: string, options: VisitOptions): Promise<PageObject | undefined> {
    const from = this.#core.stack.find(layer);
    // A layer that left the screen visits nothing any more.
    if (!from) return Promise.resolve(undefined);
    return this.#visit(from, url, options);
  }

  /** @internal A layer's reload for an action (E59) — see {@link LayerHost.reloadLayer}. */
  reloadLayer(layer: Layer, spec: ReloadSpec, drop: ReadonlySet<number>, signal: AbortSignal): Promise<boolean> {
    return this.#core.stack.reloadLayer(layer, spec, drop, signal);
  }

  /** @internal Memory keeps what a layer's props became (an action's patches committed). */
  layerChanged(layer: Layer): void {
    this.#core.stack.changed(layer);
  }

  /**
   * Closes `layer` and `close.layers - 1` beneath it — and every layer over it (E53). When their entries were pushed one
   * over the other right over what stays, that is Back in the history (Forward then asks the server again: what closed is
   * forgotten); otherwise the current entry becomes what stays. Then `close.reload` reloads what is beneath — the page and
   * the layers that stay — and a layer shown once (an action's answer) reloads them fully.
   */
  closeLayer(layer: Layer, close: LayerClose): Promise<void> {
    return this.#core.stack.closeLayer(layer, close);
  }

  /**
   * Fetches a page ahead of the visit (a hovered link): GET only, with `Purpose: prefetch`, so the server can tell
   * and leave out side effects. A visit of the same URL within `cacheFor` shows it without asking again — or
   * waits for it, if it is still under way. No events, no progress bar, no fallback: a prefetch that fails (offline,
   * 5xx, a 409 after a deployment, anything but a page) is forgotten, and the visit asks the server itself.
   */
  prefetch(url: string, options: PrefetchOptions = {}): Promise<void> {
    // Never anything but a GET — whatever a caller passes (a form, an action, is no page to fetch ahead).
    const method = (options as { method?: unknown }).method;
    if (this.#core.left || (method !== undefined && String(method).toLowerCase() !== 'get')) return Promise.resolve();
    this.#adopt();
    return this.#core.prefetches.prefetch(url, options);
  }

  /** How many prefetched pages are kept (tests). */
  get prefetchedPages(): number {
    return this.#core.prefetches.size;
  }

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

  // -- The visit pipeline -----------------------------------------------------------------------------------------------

  /**
   * A visit — of the page (`from` undefined) or of a layer over it. Where its answer goes: a page replaces the page (and
   * the layers go) — unless it is a reload of the page under the layers, which lands there; a layer's answer opens over
   * the level it came from — or replaces that layer in place when it is the same one (its key: a failed form). A layer's
   * request that the server answers with `closeLayer()` closes it.
   */
  async #visit(from: LayerControl | undefined, url: string, options: VisitOptions): Promise<PageObject | undefined> {
    this.#adopt();
    const { method = 'get', data, replace = false, preserveScroll = false, headers = {}, async: background = false, preserveUrl = false } = options;
    const preserveState = options.preserveState ?? method !== 'get';

    const target = new URL(url, this.#core.window.location.href);
    // Ask first (E64): the visit's own confirmation — a no sends nothing.
    if (options.confirm !== undefined && !(await this.confirm(options.confirm))) return undefined;
    // Unsaved changes it would take off the screen: the page and every layer — or, opening a layer, those over where it opens.
    // A visit that keeps what is on screen (in the background, a partial reload, "load more", a reload of the same page) asks nothing.
    const level = from ? this.#core.stack.indexOf(from) + 1 : 0;
    const keeps =
      background || preserveUrl || options.only !== undefined || (options.except?.length ?? 0) > 0 || (preserveState && target.pathname + target.search === (from ? from.layer.page.url : this.#core.page.url));
    const leaving = (at: number) => (options.layer === true ? at > level : at >= level);
    // Asked only when a guard is concerned — otherwise the visit starts at once (in the same task).
    if (!keeps && options.ignoreGuards !== true && this.#core.guards.blocking(leaving, options.ignoreGuards).length > 0 && !(await this.#core.guards.mayLeave(leaving, options.ignoreGuards))) return undefined;
    if (target.origin !== this.#core.window.location.origin) {
      // Another site: the browser goes there. Visits only ever read answers of this one.
      this.#core.guards.allowUnload();
      this.#leave();
      this.#core.window.location.assign(target.href);
      return undefined;
    }
    // A new build was postponed (E64): the user's next visit (a GET — a form is never thrown away) loads its page fully. One
    // that would have kept the page (a partial reload) asks first when unsaved changes are on screen.
    if (this.#core.documentChange.newVersion !== undefined && !background && method === 'get') {
      if (keeps && options.ignoreGuards !== true && !(await this.#core.guards.mayLeave(() => true, options.ignoreGuards))) return undefined;
      this.#core.guards.allowUnload();
      this.#leave();
      this.#core.window.location.assign(target.href);
      return undefined;
    }
    // What a full load the server asks for (a new build) would lose that this visit was allowed to leave already (E64).
    const consented = options.ignoreGuards === true || (!keeps && level === 0 && options.layer !== true) ? true : options.ignoreGuards;
    // A form changes what prefetched pages show: none of them is used after it.
    if (method !== 'get') this.#core.prefetches.flush();

    const request = buildRequest(target, method, data);
    const current = from ? from.layer.page : this.#core.page;
    // A partial reload names the page (or layer) it reloads: the server sends only some props when it renders that one.
    const partial = options.only !== undefined || (options.except?.length ?? 0) > 0 ? current.component : undefined;
    const partialHeaders = partial === undefined ? {} : partialReloadHeaders(partial, options.only, options.except);
    // A layer's request (E53): from inside one, or opening one.
    const asLayer = from !== undefined || options.layer === true;
    const regionHeaders: Record<string, string> = asLayer ? { [REGION_HEADER]: 'layer' } : {};
    // A plain GET visit of a prefetched URL takes that page (or waits for its request, still under way).
    const takesPrefetch = method === 'get' && partial === undefined && Object.keys(headers).length === 0;
    // An instant visit (E64) shows its placeholder — unless the page is here already (fetched ahead).
    const instant =
      options.instant && method === 'get' && !keeps && partial === undefined && !asLayer && !background && !preserveUrl && !(takesPrefetch && this.#core.prefetches.ready(request.url, asLayer))
        ? options.instant
        : undefined;
    const prefetched = takesPrefetch ? this.#core.prefetches.take(request.url, asLayer) : undefined;
    const named = options.name !== undefined ? { name: options.name } : {};
    const visit: Visit = background ? { url: request.url, method, async: true, ...named } : { url: request.url, method, ...named };
    // An async visit lands only on the page (or the layer) it started from.
    const fromKey = this.#core.key;
    // A form's optimistic patches (E59): shown while it is under way, gone with its answer (or its failure).
    const applied = applyPatches(listOf(options.optimistic));
    const untrack = options.name !== undefined && method !== 'get' ? this.#submissions.add({ name: options.name, method, url: request.url, input: data }) : undefined;
    let placeholder: InstantShown | undefined;
    try {
      return await this.#request(visit, options, async (signal, onProgress) => {
        // Its newer visit took over the screen (the older one's placeholder ends when it ends — after this one shows its own).
        if (instant && !signal.aborted) placeholder = this.#core.instant.show(instant, request.url);
        let page = prefetched ? await untilAborted(prefetched, signal) : undefined;
        if (!page) {
          if (signal.aborted) return undefined;
          const response = await this.#send(
            request.url,
            { method, headers: { ...request.headers, ...regionHeaders, ...partialHeaders, ...headers }, body: request.body, signal },
            onProgress,
          );
          if (response.headers.get(LAYER_CLOSE_HEADER) === 'true') return this.#core.stack.closed(from, response, visit, options);
          page = await this.#read(response, { replace, failed: true, consented }, visit, options);
        }
        if (!page || signal.aborted) return undefined;
        if (background && (this.#core.left || this.#core.key !== fromKey || this.#core.transitioning || from?.layer.closed)) return undefined;
        // The answer replaces what the patches showed — in the same render (the server's props then, or its errors).
        for (const [target, ids] of applied) target.settle(ids, false, { quiet: true });
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
      // Failed, cancelled, or the browser took over: nothing of the patches stays.
      rollBack(applied);
      untrack?.();
      // Ended without its page (failed, cancelled, a 409 postponed): the page on screen comes back, where it was scrolled to.
      if (placeholder) this.#core.instant.end(placeholder);
    }
  }

  /** Where a visit's answer goes — see {@link Navigator.#visit}: the layers take theirs, anything else is the page. */
  async #place(from: LayerControl | undefined, page: PageObject, options: PlaceOptions): Promise<PageObject | undefined> {
    const placed = this.#core.stack.place(from, page, options);
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
    if (this.#core.key !== undefined) return undefined;
    const state: unknown = this.#core.window.history.state;
    // A reload or session restore keeps the entry's key (and scroll); the page itself came fresh from the server.
    const restored = isHistoryState(state) ? state : undefined;
    // Where the entry is: kept by a reload or a session restore, else the last (a fresh load pushes its entry at the end).
    this.#core.history.index = typeof restored?.index === 'number' ? restored.index : Math.max(0, (this.#core.window.history.length ?? 1) - 1);
    const key = restored?.key ?? newKey();
    const position = restored ? this.#core.scroll.of(restored) : TOP;
    this.#core.key = this.#core.stack.deepLink ? newKey() : key;
    this.#core.props.adopt(this.#core.key, this.#core.page);
    this.#core.cache.set(this.#core.key, { page: this.#core.page, ...keptOf(this.#core.owner) });
    if (this.#core.stack.deepLink) this.#core.stack.adopt(this.#core.key, key, position);
    else this.#core.history.replace(entry(this.#core.page, this.#core.key, position), this.#core.window.location.href);
    return restored;
  }

  async #show(
    page: PageObject,
    history: 'push' | 'replace',
    { preserveScroll, preserveState, hash }: { preserveScroll: boolean; preserveState: boolean; hash: string },
  ): Promise<PageObject | undefined> {
    // Under an instant visit's placeholder (E64), the page being left was scrolled where it was before it showed.
    const leaving = this.#core.instant.leaving ?? this.#core.scroll.current();
    this.#core.scroll.cancelSave();
    this.#core.transitioning = true;
    // The page's islands: those of the page on screen when its state is kept (the same component — a partial reload, a
    // sort link): replaced in place, they stay; pushed, the new entry starts with a copy. Any other page starts empty.
    const keep = preserveState && page.component === this.#core.page.component;
    // A page replaces the layers too (E53): the entry being left (or replaced) is the top layer's.
    const layered = this.#core.stack.controls.length > 0;
    const owner = history === 'replace' && keep && !layered ? this.#core.owner : new RegionOwner(this.#core.transport, keep ? new Map(this.#core.owner.regions) : new Map());
    // The entry the page goes into: a new one, or the one on screen (then its optimistic patches still show over the answer).
    const top = this.#core.stack.top();
    const key = history === 'push' ? newKey() : top;
    try {
      try {
        await this.#draw(this.#core.patches.paint(key, page), { preserveState, owner, layers: [] });
      } catch {
        // The page's code could not be loaded (a chunk gone after a deployment, offline): the browser loads it.
        if (owner !== this.#core.owner) owner.close();
        this.#leave();
        this.#core.window.location.assign(page.url);
        return undefined;
      }
      const arrived = preserveScroll ? this.#core.scroll.current() : TOP;
      if (history === 'push') {
        // Remember where the page being left was scrolled to — Back restores it.
        this.#core.scroll.set(top, leaving);
        this.#core.history.replace(this.#core.stack.stateOf(top, leaving), this.#core.window.location.href);
        this.#core.key = key;
        this.#core.history.push(entry(page, this.#core.key, arrived), page.url + hash);
      } else {
        // Replacing a layer's entry: the entry is this page's now.
        this.#core.key = top;
        this.#core.history.replace(entry(page, this.#core.key, arrived), page.url + hash);
      }
      this.#core.stack.dismissFrom(0);
      this.#core.scroll.set(this.#core.key!, arrived);
      this.#core.cache.set(this.#core.key!, { page, ...keptOf(owner) });
      this.#switchOwner(owner);
      this.#setPage(page);
      if (!preserveScroll) this.#core.scroll.apply(TOP);
      if (hash) this.#core.window.document?.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
      this.#core.props.load();
      return page;
    } finally {
      this.#core.transitioning = false;
    }
  }

  // -- Back/Forward -----------------------------------------------------------------------------------------------------

  readonly #onPopState = (event: Event): void => {
    const state: unknown = (event as PopStateEvent).state;
    // `null`: an entry of a fragment link (`#section`) on the same page.
    if (state === null || state === undefined) return;
    // The guard's own popstate, or a Back/Forward it stops (E64) — not for a layer closing by going back: its close asked.
    if (this.#core.guards.popState(state, this.#core.stack.closing)) return;
    // Back/Forward during an instant visit (E64): the visit is cancelled, and what the entry shows takes the placeholder's place.
    this.#core.instant.cancel();
    if (isHistoryState(state) && typeof state.index === 'number') this.#core.history.index = state.index;
    // Going back because a layer closes: the visit that closed it (a form's `closeLayer()`) is not cancelled by it.
    const closing = this.#core.stack.takeClose();
    if (!closing) this.#inFlight?.abort();
    // A save still pending belongs to the entry just left; the browser already switched to the new one.
    this.#core.scroll.cancelSave();
    if (isHistoryState(state)) {
      const stack = this.#core.stack.cached(state.key);
      if (stack) {
        void this.#arriveAt(state, stack, closing);
        return;
      }
      closing?.done();
      if (state.layer) void this.#core.stack.restore(state);
      else void this.#restore(state.url, state.key, this.#core.scroll.of(state));
      return;
    }
    closing?.done();
    // An entry of an older client, which kept whole pages in the history: never shown — the server is asked.
    if (isPageObject(state)) void this.#restore(state.url, newKey(), TOP);
  };

  /**
   * Back/Forward to an entry in memory: its page and the layers over it. When it is the page on screen with other layers
   * (a layer closed by Back, opened again by Forward), only the layers change — the page is not rendered again, does not
   * scroll, and none of its deferred props or islands load again.
   */
  async #arriveAt(state: HistoryState, stack: CachedStack, closing: PendingClose | undefined): Promise<void> {
    try {
      if (stack.page === this.#core.key && !this.#core.left) {
        const before = new Set(this.#core.stack.controls);
        const removed = this.#core.stack.set(stack.layers);
        for (const key of closing?.forget ?? []) this.#core.cache.delete(key);
        await this.#core.stack.render();
        // Layers Forward opened again from memory: what their views declare reloads (E58) — the page stayed on screen.
        if (!closing) for (const control of this.#core.stack.controls) if (!before.has(control)) void this.#core.back.layer(control);
        // An action's answer (shown once) left: what is beneath reloads — or what the closing asked for.
        const reload = closing?.reload ?? (removed.some((layer) => layer.once) ? true : undefined);
        if (reload !== undefined) await this.#core.stack.reloadTop(reload);
        return;
      }
      this.#core.stack.dismissFrom(0);
      for (const key of closing?.forget ?? []) this.#core.cache.delete(key);
      const base = this.#core.cache.peek(stack.page)!;
      this.#core.key = stack.page;
      // The entry's islands come back with it, from memory — no request (but what their views declare reloads, E58).
      const owner = new RegionOwner(this.#core.transport, base.regions, { onBack: this.#core.back.region, remembered: base.remembered });
      this.#switchOwner(owner);
      this.#setPage(base.page);
      this.#core.stack.set(stack.layers, { restored: true });
      await this.#arrive(base.page, this.#core.scroll.of(state), owner);
      // Shown from memory at once — then what the views declare reloads in the background (E58).
      if (!closing && this.#core.key === stack.page) {
        void this.#core.back.page(stack.page, base.page);
        for (const control of this.#core.stack.controls) void this.#core.back.layer(control);
      }
    } finally {
      closing?.done();
    }
  }

  /** Renders a page of the history and scrolls to where it was. */
  async #arrive(page: PageObject, position: Scroll, owner: RegionOwner): Promise<void> {
    this.#core.transitioning = true;
    try {
      await this.#draw(this.#core.patches.paint(this.#core.key!, page), { preserveState: false, owner, layers: this.layers });
      this.#core.scroll.apply(position);
      this.#core.props.load();
      this.#core.stack.loadAllDeferred();
    } catch {
      this.#leave();
      this.#core.window.location.reload();
    } finally {
      this.#core.transitioning = false;
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
        this.#leave();
        this.#core.window.location.reload();
        return undefined;
      }
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
    this.#core.history.replace(entry(page, key, position), page.url);
    this.#core.stack.dismissFrom(0);
    this.#core.key = key;
    const owner = new RegionOwner(this.#core.transport);
    this.#core.cache.set(key, { page, ...keptOf(owner) });
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
    if (this.#core.transitioning || this.#core.key === undefined) return;
    this.#core.scroll.set(this.#core.key, this.#core.scroll.current());
    // Into the entry too, for a reload or a session restore — debounced: browsers throttle replaceState.
    this.#core.scroll.saveLater(() => {
      const key = this.#core.key;
      const state: unknown = this.#core.window.history.state;
      if (this.#core.transitioning || key === undefined || !isHistoryState(state) || state.key !== key) return;
      const position = this.#core.scroll.get(key);
      if (position) this.#core.history.replace(withPosition(state, position), this.#core.window.location.href);
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
      this.#leave();
      this.#core.window.location.assign(response.url || new URL(visit.url, this.#core.window.location.href).href);
      return undefined;
    }
    return this.#collect((await response.json()) as PageObject);
  }

  /** Sends a request with the page headers — through XHR for `FormData` with a progress listener (upload progress). */
  #send(url: string, { method, headers, body, signal }: SendInit, onProgress?: (progress: VisitProgress) => void): Promise<Response> {
    const init = {
      method: method.toUpperCase(),
      // The once props held (E64): the server does not compute them again.
      headers: { [PAGE_HEADER]: 'true', ...(this.#core.version ? { [VERSION_HEADER]: this.#core.version } : {}), ...this.#core.once.headers(), ...headers },
      body,
      signal,
    };
    const Xhr = this.#core.window.XMLHttpRequest;
    if (body instanceof FormData && onProgress && Xhr) return sendWithProgress(Xhr, url, init, onProgress);
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

  /** Renders, then fires what the rendered answer brought (E60) — the page's layout shows a toast over the new page, not the old. */
  async #draw(page: PageObject, options: RenderOptions): Promise<void> {
    // A page takes the place of an instant visit's placeholder (E64).
    this.#core.instant.replaced();
    await this.#render(page, options);
    this.#flushFlash();
  }

  #setVisiting(visit: Visit | undefined): void {
    if (this.#visiting === visit) return;
    this.#visiting = visit;
    notify(this.#visitingListeners);
  }

  /** Before a full page load: nothing kept in memory survives it, should the browser bring this document back. */
  #leave(): void {
    this.#core.left = true;
    // Remembered state (E63) and once props (E64): not for whoever comes next — forgotten, also where a component still holds them.
    for (const kept of this.#core.cache.values()) kept.remembered.clear();
    this.#core.owner.remembered.clear();
    for (const layer of this.#core.stack.list) layer.owner.remembered.clear();
    this.#core.once.clear();
    // Flash messages waiting for a listener are not for whoever comes next (signed out); the server keeps a 409's.
    this.#core.inbox.length = 0;
    this.#core.flash.clear();
    // Nothing optimistic either, and no action lands any more (signed out: their answers are not for whoever comes next).
    this.#core.patches.clear();
    this.#actions.abortAll();
    this.#submissions.clear();
    // Islands too: none of them lands any more, and none of what they showed survives (signing out). Layers alike.
    this.#core.owner.close();
    this.#core.stack.leave();
    this.#core.cache.clear();
    // Prefetched while signed in: not for whoever comes next — and one still under way lands nowhere.
    this.#core.prefetches.flush();
    // A deferred prop still loading must not come back into a page of someone who has left (signed out).
    for (const request of this.#background) request.abort();
  }
}

/** The validation errors a page carries (the shared `errors` prop), or undefined when there are none. */
function validationErrors(page: PageObject): ValidationErrors | undefined {
  const errors = (page.props as { errors?: unknown }).errors;
  return typeof errors === 'object' && errors !== null && Object.keys(errors).length > 0 ? (errors as ValidationErrors) : undefined;
}

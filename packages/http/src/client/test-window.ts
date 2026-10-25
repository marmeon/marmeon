/** The browser of the client core's tests: one tab's history, location, fetch and events — in memory. */
import { protocolHeaders, type PageObject } from '../protocol.ts';
import type { ActionOptions } from './action.ts';
import { actions } from './features/actions.ts';
import { optimistic } from './features/optimistic.ts';
import { Navigator, type NavigatorWindow, type ScrollRegion } from './navigation.ts';
import type { OptimisticUpdate, PropsPatch, Reloading, ReloadSpec } from './optimistic.ts';
import type { Layer } from './layer.ts';
import { REGIONS, type RegionOwner } from './owner.ts';
import { defineFeature, type Feature } from './feature.ts';
import { historyFallback } from './features/history-fallback.ts';
import type { NavigateEvent, NavigationEntry, NavigationLike } from './history.ts';
import type { KeptRegion } from './region.ts';
// The chunk deferred props load from, already in the module cache: a test waits a tick for it, not for a cold import.
import './prop-loader.ts';

export const ORIGIN = 'https://app.test';

export const page = (url: string, props: Record<string, unknown> = {}, component = 'pages/Show'): PageObject => ({ component, props, url, version: null });

export const pageResponse = (body: PageObject) => new Response(JSON.stringify(body), { headers: { ...protocolHeaders(), 'content-type': 'application/json' } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/**
 * A live stream as the browser's `EventSource` — what the test makes the server say: `emit('hello', { seq })`,
 * `emit('refresh', hint)`, `fail()` (it broke: the browser reconnects), `fail(true)` (refused: it gives up).
 */
export class FakeEventSource extends EventTarget {
  readonly url: string;
  readyState = 0;
  constructor(url: string) {
    super();
    this.url = url;
  }
  /** The channels it follows — from its URL. */
  get channels(): string[] {
    return new URL(this.url, ORIGIN).searchParams.getAll('c').map((pair) => pair.slice(pair.indexOf('.') + 1));
  }
  get closed(): boolean {
    return this.readyState === 2;
  }
  emit(event: string, data: unknown): void {
    this.readyState = 1;
    this.dispatchEvent(Object.assign(new Event(event), { data: JSON.stringify(data) }));
  }
  fail(closed = false): void {
    this.readyState = closed ? 2 : 0;
    this.dispatchEvent(new Event('error'));
  }
  close(): void {
    this.readyState = 2;
  }
}

/**
 * The `BroadcastChannel`s of one browser: what a tab posts, every other tab's channel of the same name hears a task
 * later — never the sender (like the browser's), and never a tab that is `frozen` (it misses it: a frozen tab's queue is not
 * promised). `posted` is everything any tab ever posted, structured-cloned as the browser would.
 */
export class FakeChannels {
  readonly posted: { readonly name: string; readonly data: unknown }[] = [];
  readonly #open = new Set<{ readonly name: string; readonly target: EventTarget; readonly win: { frozen: boolean } }>();

  /** The constructor a tab's `window.BroadcastChannel` is. */
  constructorFor(win: { frozen: boolean }): new (name: string) => BroadcastChannel {
    const open = this.#open;
    const posted = this.posted;
    return class extends EventTarget {
      readonly name: string;
      readonly #self: { readonly name: string; readonly target: EventTarget; readonly win: { frozen: boolean } };
      constructor(name: string) {
        super();
        this.name = name;
        this.#self = { name, target: this, win };
        open.add(this.#self);
      }
      postMessage(data: unknown): void {
        const clone = structuredClone(data);
        posted.push({ name: this.name, data: clone });
        const from = this.#self;
        setTimeout(() => {
          for (const other of open) {
            if (other === from || other.name !== from.name || other.win.frozen) continue;
            other.target.dispatchEvent(new MessageEvent('message', { data: structuredClone(clone) }));
          }
        }, 0);
      }
      close(): void {
        open.delete(this.#self);
      }
    } as never;
  }

  /** Channels open now. */
  get open(): number {
    return this.#open.size;
  }

  /** A message as another page of the site would post it (any shape) — to every tab's channel `name`. */
  inject(data: unknown, name = 'marmeon'): void {
    for (const other of this.#open) if (other.name === name && !other.win.frozen) other.target.dispatchEvent(new MessageEvent('message', { data }));
  }
}

/**
 * Which way the navigator writes the history in a fake tab: the Navigation API, the History fallback without it, or the
 * Navigation API as WebKit has it — a traversal's destination does not carry its state (`getState()` is `undefined`).
 */
export type HistoryPath = 'navigation' | 'history' | 'webkit';

/** All ways — a suite that runs on each (`describe.each(PATHS)`). */
export const PATHS: readonly HistoryPath[] = ['navigation', 'history', 'webkit'];

let nextKey = 0;

/**
 * One entry of a tab's history, as the browser keeps it: its URL, its `history.state` and its Navigation API state — each stored
 * *serialized* (structured clone, written to disk for session restore): the test reads exactly what would end up there. `key`
 * is the browser's (the Navigation API's `entry.key`), kept by a reload and a session restore.
 */
export class FakeEntry {
  url: string;
  /** `history.state`, serialized — `null` for an entry the Navigation API wrote. */
  history: string;
  /** The Navigation API's state, serialized — undefined when it has none (a `pushState` entry, one a `replaceState` rewrote). */
  navigation: string | undefined;
  readonly key: string;
  /** An entry of another document (a full load came in between, another site): Back to it loads that document — nothing intercepts it. */
  crossDocument = false;

  constructor(url: string, history = 'null', navigation?: string, key = `entry-${nextKey++}`) {
    this.url = url;
    this.history = history;
    this.navigation = navigation;
    this.key = key;
  }

  /** The state the navigator wrote into it — the Navigation API's, or (in the History fallback) `history.state`. */
  get state(): string {
    return this.navigation ?? this.history;
  }

  /** Everything the browser writes to disk for it. */
  get disk(): string {
    return `${this.history} ${this.navigation ?? ''}`;
  }
}

/** A `navigate` event as the browser fires it (Chrome 154), with what a test reads afterwards. */
class FakeNavigateEvent extends Event implements NavigateEvent {
  readonly navigationType: NavigateEvent['navigationType'];
  readonly canIntercept: boolean;
  readonly userInitiated: boolean;
  readonly info: unknown;
  readonly hashChange: boolean;
  readonly destination: NavigationEntry & { readonly url: string; readonly sameDocument: boolean };
  /** What `intercept()` was given, in order — empty: not intercepted. */
  readonly intercepted: { scroll?: string; focusReset?: string; handler?: () => unknown; precommitHandler?: unknown }[] = [];

  constructor(init: Pick<FakeNavigateEvent, 'navigationType' | 'canIntercept' | 'userInitiated' | 'info' | 'hashChange' | 'destination'> & { cancelable: boolean }) {
    super('navigate', { cancelable: init.cancelable });
    this.navigationType = init.navigationType;
    this.canIntercept = init.canIntercept;
    this.userInitiated = init.userInitiated;
    this.info = init.info;
    this.hashChange = init.hashChange;
    this.destination = init.destination;
  }

  /** Every call of `intercept()`, also those the browser refused (`canIntercept` false: a SecurityError). */
  attempts = 0;

  intercept(options: FakeNavigateEvent['intercepted'][number] = {}): void {
    this.attempts++;
    if (!this.canIntercept) throw new DOMException('Cannot intercept', 'SecurityError');
    this.intercepted.push(options);
  }
}

/** What `navigate()`/`traverseTo()` return. */
interface FakeNavigationResult {
  readonly committed: Promise<NavigationEntry>;
  readonly finished: Promise<NavigationEntry>;
}

/** An early error (an unknown key, a traversal refused): both promises reject — nobody catching them is an unhandled rejection. */
const early = (name: string, message: string): FakeNavigationResult => {
  const error = new DOMException(message, name);
  return { committed: Promise.reject(error), finished: Promise.reject(error) };
};

/** A result whose rejections nobody needs to catch. */
const handled = (result: FakeNavigationResult): FakeNavigationResult => {
  result.committed.catch(() => undefined);
  result.finished.catch(() => undefined);
  return result;
};

/**
 * The Navigation API of a fake tab (`window.navigation`), over the tab's entries — modelled on what Chrome 154 does:
 * `navigate()` fires `navigate` (push/replace, cancelable), commits a same-document entry when a listener intercepted it
 * (else the document is loaded — a spy entry in `loads`), its handlers run after the commit (`transition` meanwhile). Traversals
 * (`back`/`forward`/`traverseTo`, `history.go`) run a task later and are always cancelable from a script; the user's own Back
 * (`win.back()`) is cancelable only with a fresh activation (`win.activate()`), which it uses up. `traverseTo` right after a
 * cancelled traversal (in the same task) refuses: `InvalidStateError`, as in Chrome. `precommitHandler` is only there to be
 * detected (`intercept` takes it; nothing runs it).
 */
export class FakeNavigation extends EventTarget implements NavigationLike {
  readonly #win: FakeWindow;
  /** A traversal was cancelled in this task: another one is refused until the next. */
  #refusing = false;
  transition: { readonly navigationType: string; readonly from: NavigationEntry; readonly finished: Promise<void> } | null = null;
  /** Every `navigate` event fired, in order. */
  readonly events: FakeNavigateEvent[] = [];

  /** WebKit: the destination of a traversal has no state (the entry it goes to has). */
  readonly #stateless: boolean;

  constructor(win: FakeWindow, stateless = false) {
    super();
    this.#win = win;
    this.#stateless = stateless;
  }

  #view(entry: FakeEntry): NavigationEntry & { readonly url: string; readonly sameDocument: boolean; readonly id: string } {
    const index = this.#win.entries.indexOf(entry);
    return {
      key: entry.key,
      id: `${entry.key}:${entry.navigation ?? ''}`,
      index,
      url: entry.url,
      sameDocument: true,
      getState: () => (entry.navigation === undefined ? undefined : JSON.parse(entry.navigation)),
    };
  }

  entries(): NavigationEntry[] {
    return this.#win.entries.map((entry) => this.#view(entry));
  }

  get currentEntry(): NavigationEntry {
    return this.#view(this.#win.current);
  }

  get canGoBack(): boolean {
    return this.#win.index > 0;
  }

  get canGoForward(): boolean {
    return this.#win.index < this.#win.entries.length - 1;
  }

  navigate(url: string, { state, history = 'auto', info }: { state?: unknown; history?: 'auto' | 'push' | 'replace'; info?: unknown } = {}, userInitiated = false): FakeNavigationResult {
    const win = this.#win;
    const to = new URL(url, win.current.url);
    const replace = history === 'replace';
    const serialized = state === undefined ? undefined : JSON.stringify(state);
    const event = this.fire({
      navigationType: replace ? 'replace' : 'push',
      canIntercept: to.origin === new URL(win.current.url).origin,
      cancelable: true,
      userInitiated,
      info,
      hashChange: isHashChange(win.current.url, to.href),
      destination: { key: replace ? win.current.key : '', index: replace ? win.index : win.index + 1, url: to.href, sameDocument: false, getState: () => (serialized === undefined ? undefined : JSON.parse(serialized)) },
    });
    if (event.defaultPrevented) return handled(early('AbortError', 'Navigation was aborted'));
    if (event.intercepted.length === 0 && !event.hashChange) {
      // Not intercepted: the browser loads the document — whose promises never settle (it is gone).
      win.loads.push(`${replace ? 'replace' : 'assign'} ${to.href}`);
      return { committed: new Promise(() => {}), finished: new Promise(() => {}) };
    }
    const from = this.currentEntry;
    const entry = new FakeEntry(to.href, 'null', serialized, replace ? win.current.key : undefined);
    win.commit(entry, replace);
    return this.#run(event, entry, from);
  }

  updateCurrentEntry({ state }: { state: unknown }): void {
    this.#win.current.navigation = JSON.stringify(state);
    this.dispatchEvent(new Event('currententrychange'));
  }

  back(): FakeNavigationResult {
    return this.traverseTo(this.#win.entries[this.#win.index - 1]?.key ?? '');
  }

  forward(): FakeNavigationResult {
    return this.traverseTo(this.#win.entries[this.#win.index + 1]?.key ?? '');
  }

  /** A traversal from a script: a task later, always cancelable (same document). */
  traverseTo(key: string): FakeNavigationResult {
    if (this.#refusing) return early('InvalidStateError', 'Invalid key');
    const target = this.#win.entries.findIndex((entry) => entry.key === key);
    if (target < 0) return early('InvalidStateError', 'Invalid key');
    let done!: (result: FakeNavigationResult | undefined) => void;
    const result = new Promise<FakeNavigationResult | undefined>((resolve) => (done = resolve));
    setTimeout(() => done(this.traverse(target, { userInitiated: false, cancelable: true })));
    const finished = result.then((inner) => inner?.finished);
    finished.catch(() => undefined);
    return { committed: result.then((inner) => inner?.committed) as Promise<NavigationEntry>, finished: finished as Promise<NavigationEntry> };
  }

  /** Traverses to the entry at `target` now: `navigate` (traverse), then — unless cancelled — the commit, `popstate`, the handlers. */
  traverse(target: number, { userInitiated, cancelable }: { userInitiated: boolean; cancelable: boolean }): FakeNavigationResult | undefined {
    const win = this.#win;
    const entry = win.entries[target];
    if (!entry || target === win.index) return undefined;
    const event = this.fire({
      navigationType: 'traverse',
      canIntercept: !entry.crossDocument,
      cancelable: cancelable && !entry.crossDocument,
      userInitiated,
      info: undefined,
      hashChange: isHashChange(win.current.url, entry.url),
      destination: this.#stateless ? { ...this.#view(entry), getState: () => undefined } : this.#view(entry),
    });
    if (event.defaultPrevented) {
      this.#refusing = true;
      setTimeout(() => (this.#refusing = false));
      // Its promises reject (AbortError) — the browser's Back has none, a script's may not listen: nothing unhandled.
      return handled(early('AbortError', 'Navigation was aborted'));
    }
    if (entry.crossDocument) {
      // Another document: the browser loads it (this one is gone).
      win.loads.push(`traverse ${entry.url}`);
      return { committed: new Promise(() => {}), finished: new Promise(() => {}) };
    }
    const from = this.currentEntry;
    win.moveTo(target);
    return this.#run(event, entry, from);
  }

  fire(init: ConstructorParameters<typeof FakeNavigateEvent>[0]): FakeNavigateEvent {
    const event = new FakeNavigateEvent(init);
    this.events.push(event);
    this.dispatchEvent(event);
    return event;
  }

  /** The handlers of an intercepted navigation run after its commit — `transition` is set until they settle. */
  #run(event: FakeNavigateEvent, entry: FakeEntry, from: NavigationEntry): FakeNavigationResult {
    const handlers = event.intercepted.flatMap((options) => (options.handler ? [options.handler] : []));
    const view = this.#view(entry);
    if (handlers.length === 0) return { committed: Promise.resolve(view), finished: Promise.resolve(view) };
    const finished = Promise.resolve()
      .then(() => Promise.all(handlers.map((handler) => handler())))
      .then(() => view)
      .finally(() => {
        if (this.transition?.finished === done) this.transition = null;
      });
    const done = finished.then(() => undefined, () => undefined);
    this.transition = { navigationType: event.navigationType, from, finished: done };
    finished.catch(() => undefined);
    return { committed: Promise.resolve(view), finished };
  }
}

/** Whether `to` differs from `from` only in its fragment (and has one). */
function isHashChange(from: string, to: string): boolean {
  const [a, b] = [new URL(from), new URL(to)];
  return b.hash !== '' && a.href.replace(a.hash, '') === b.href.replace(b.hash, '');
}

/**
 * One tab's history, as the browser keeps it: states are stored *serialized* (structured clone, written to
 * disk for session restore) — the test reads exactly what would end up there. With the Navigation API (`navigation`, the default
 * path) or without it — the History fallback (`new FakeWindow(url, channels, 'history')`, or `FakeWindow.path`).
 */
type StartViewTransition = NonNullable<NonNullable<NavigatorWindow['document']>['startViewTransition']>;

/** A view transition the fake document started: its types, and what became of it. */
export interface FakeViewTransition {
  readonly types: readonly string[];
  /** Its update ran (the swap is in). */
  updated: boolean;
  /** Skipped while it animated (`skipTransition`). */
  skipped: boolean;
}

export class FakeWindow implements NavigatorWindow {
  /** The path a new fake tab takes when none is given — a suite that runs on both sets it (`PATHS`). */
  static path: HistoryPath = 'navigation';
  readonly entries: FakeEntry[] = [];
  index = -1;
  /** Every URL the address bar showed, in order (each commit, each Back/Forward) — a Back the guard cancels shows none. */
  readonly shownUrls: string[] = [];
  readonly requests: { url: string; method: string; headers: Record<string, string> }[] = [];
  readonly loads: string[] = [];
  scrollX = 0;
  scrollY = 0;
  scrollRestoration: ScrollRestoration = 'auto';
  /** The Navigation API — undefined on the History fallback's path. */
  readonly navigation: FakeNavigation | undefined;
  /** The user just clicked or typed (a fresh user activation): their next Back/Forward is cancelable — and uses it up. */
  #activated = false;
  /** The page's `[scroll-region]` elements. */
  regions: ScrollRegion[] = [];
  /** `loading` while the document "still streams" — `finishLoading()` ends it. */
  readyState = 'complete';
  readonly #loaded = new Set<() => void>();
  readonly document: NonNullable<NavigatorWindow['document']>;
  XMLHttpRequest?: new () => XMLHttpRequest;
  /** The tab is shown or hidden (`hide()`, `show()`) — a live stream over HTTP/1.1 waits while hidden. */
  visibilityState: DocumentVisibilityState = 'visible';
  /** The protocol the document came over (`nextHopProtocol`) — `''`: unknown. */
  protocol = 'h2';
  /** The live streams opened, oldest first — `EventSource` of this tab. */
  readonly sources: FakeEventSource[] = [];
  EventSource?: new (url: string) => EventSource;
  /** The browser's channels between tabs — with `new FakeWindow(url, channels)`. */
  BroadcastChannel?: new (name: string) => BroadcastChannel;
  /** A frozen tab (Page Lifecycle): it hears nothing on the channels. */
  frozen = false;
  /** An element has `ratio` of itself in view (0: gone) — what the observer reports, if it watches the element. */
  see(element: Element, ratio: number): void {
    this.#ratios.set(element, ratio);
    if (this.watching.has(element)) this.#intersected?.([{ target: element, isIntersecting: ratio > 0, intersectionRatio: ratio }]);
  }
  /** The user prefers reduced motion (`prefers-reduced-motion: reduce`). */
  reducedMotion = false;
  /** The view transitions the document started — once it has them (`supportViewTransitions()`). */
  readonly transitions: FakeViewTransition[] = [];
  /** What happened, in order, for tests that follow a view transition: `transition`, `updated`, `animated`, the scroll. */
  readonly log: string[] = [];
  readonly performance: NonNullable<NavigatorWindow['performance']>;
  /** The elements the document's `IntersectionObserver` watches — `see(element, ratio)` reports one of them. */
  readonly watching = new Set<Element>();
  IntersectionObserver?: NavigatorWindow['IntersectionObserver'];
  /** `connection` of the browser's `navigator` — Save-Data and the speed of the network. */
  navigator: { connection?: { saveData?: boolean; effectiveType?: string } } = {};
  readonly #ratios = new Map<Element, number>();
  #intersected: ((entries: { target: Element; isIntersecting: boolean; intersectionRatio: number }[]) => void) | undefined;
  readonly #documentListeners = new Map<string, Set<() => void>>();
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();
  handler: Handler = () => new Response('not found', { status: 404 });
  /** The browser's own dialogs — what they were asked, and what the "user" answers. */
  readonly asked: string[] = [];
  confirmAnswer = false;
  promptAnswer: string | null = null;
  confirm = (message?: string): boolean => {
    this.asked.push(`confirm ${message ?? ''}`);
    return this.confirmAnswer;
  };
  prompt = (message?: string): string | null => {
    this.asked.push(`prompt ${message ?? ''}`);
    return this.promptAnswer;
  };

  constructor(url: string, channels?: FakeChannels, path: HistoryPath = FakeWindow.path) {
    this.entries.push(new FakeEntry(url));
    this.shownUrls.push(url);
    if (channels) this.BroadcastChannel = channels.constructorFor(this);
    this.navigation = path === 'history' ? undefined : new FakeNavigation(this, path === 'webkit');
    this.index = 0;
    const self = this;
    this.document = {
      querySelectorAll: (selector: string) => (selector === '[scroll-region]' ? this.regions : []),
      getElementById: () => null,
      get readyState(): string {
        return self.readyState;
      },
      get visibilityState(): DocumentVisibilityState {
        return self.visibilityState;
      },
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'DOMContentLoaded') return void this.#loaded.add(listener);
        if (!this.#documentListeners.has(type)) this.#documentListeners.set(type, new Set());
        this.#documentListeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => void this.#documentListeners.get(type)?.delete(listener),
    };
    const watching = this.watching;
    this.IntersectionObserver = class {
      constructor(callback: NonNullable<FakeWindow['IntersectionObserver']> extends new (callback: infer C, ...rest: never) => unknown ? C : never) {
        self.#intersected = callback as never;
      }
      observe(element: Element) {
        watching.add(element);
        // As a browser does: the element's state now, once it is watched.
        const ratio = self.#ratios.get(element);
        if (ratio !== undefined) queueMicrotask(() => self.see(element, ratio));
      }
      unobserve(element: Element) {
        watching.delete(element);
      }
      disconnect() {
        watching.clear();
      }
    };
    this.performance = { getEntriesByType: () => [{ nextHopProtocol: self.protocol }] as never };
    const sources = this.sources;
    this.EventSource = class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        sources.push(this);
      }
    } as never;
  }

  matchMedia(query: string): { readonly matches: boolean } {
    return { matches: this.reducedMotion && query === '(prefers-reduced-motion: reduce)' };
  }

  /**
   * The document gets view transitions, as Chrome has them: `startViewTransition` captures the old state first (a task later),
   * then runs the update (`updateCallbackDone` once it is in) and animates (another task) — a newer one or `skipTransition` skips the
   * animation. `types: false`: a browser without types (Chrome before 125) — an object as the argument throws.
   */
  supportViewTransitions({ types = true }: { types?: boolean } = {}): void {
    const { transitions, log } = this;
    (this.document as { startViewTransition?: StartViewTransition }).startViewTransition = (options) => {
      if (!types) throw new TypeError("Failed to execute 'startViewTransition' on 'Document': The callback provided as parameter 1 is not a function.");
      // A newer transition skips the one still animating.
      const previous = transitions.at(-1) as (FakeViewTransition & { animated?: boolean }) | undefined;
      if (previous && !previous.animated) previous.skipped = true;
      const started: FakeViewTransition & { animated?: boolean } = { types: [...options.types], updated: false, skipped: false };
      transitions.push(started);
      log.push(`transition ${options.types.join(' ')}`);
      const updateCallbackDone = new Promise<void>((resolve) => setTimeout(resolve)).then(options.update).then(() => {
        started.updated = true;
        log.push('updated');
      });
      const finished = updateCallbackDone.then(() => new Promise<void>((resolve) => setTimeout(resolve, 5))).then(() => {
        started.animated = true;
        if (!started.skipped) log.push('animated');
      });
      return { updateCallbackDone, ready: updateCallbackDone, finished, skipTransition: () => void (started.skipped ||= !started.animated) };
    };
  }

  /** The live stream open now (the last one, unless it was closed). */
  get source(): FakeEventSource | undefined {
    const last = this.sources.at(-1);
    return last && !last.closed ? last : undefined;
  }

  /** The user switches to another tab (`visibilitychange`). */
  hide(): void {
    this.visibilityState = 'hidden';
    this.#documentEvent('visibilitychange');
  }

  /** The user comes back to this tab. */
  show(): void {
    this.visibilityState = 'visible';
    this.#documentEvent('visibilitychange');
  }

  /** The browser unfreezes the tab (Page Lifecycle `resume`). */
  resume(): void {
    this.#documentEvent('resume');
  }

  #documentEvent(type: string): void {
    for (const listener of this.#documentListeners.get(type) ?? []) listener();
  }

  /** The document has arrived completely (`DOMContentLoaded`). */
  finishLoading(): void {
    this.readyState = 'interactive';
    for (const listener of this.#loaded) listener();
    this.#loaded.clear();
  }

  get history(): NavigatorWindow['history'] {
    const win = this;
    return {
      get state(): unknown {
        return JSON.parse(win.current.history);
      },
      // With the Navigation API, these fire `navigate` too (push/replace, never intercepted by the navigator) — and the entry has no
      // Navigation API state then: `replaceState` erases the one it had (as in Chrome).
      pushState(state: unknown, _title: string, url?: string | URL | null) {
        win.#write(state, url, false);
      },
      replaceState(state: unknown, _title: string, url?: string | URL | null) {
        win.#write(state, url, true);
      },
      // Like the browser's: asynchronous — the entry changes a task later (then `navigate`, or popstate without the Navigation API).
      go(delta: number) {
        setTimeout(() => {
          const index = win.index + delta;
          if (delta === 0 || index < 0 || index >= win.entries.length) return;
          if (win.navigation) return void win.navigation.traverse(index, { userInitiated: false, cancelable: true });
          win.moveTo(index);
          win.dispatch('popstate', { state: win.history.state });
        }, 0);
      },
      get length() {
        return win.entries.length;
      },
      get scrollRestoration() {
        return win.scrollRestoration;
      },
      set scrollRestoration(value: ScrollRestoration) {
        win.scrollRestoration = value;
      },
    } as NavigatorWindow['history'];
  }

  #write(state: unknown, url: string | URL | null | undefined, replace: boolean): void {
    const to = this.#resolve(url);
    if (this.navigation) {
      const event = this.navigation.fire({
        navigationType: replace ? 'replace' : 'push',
        canIntercept: true,
        cancelable: true,
        userInitiated: false,
        info: undefined,
        hashChange: false,
        destination: { key: replace ? this.current.key : '', index: replace ? this.index : this.index + 1, url: to, sameDocument: true, getState: () => undefined },
      });
      if (event.defaultPrevented) return;
    }
    this.commit(new FakeEntry(to, JSON.stringify(state), undefined, replace ? this.current.key : undefined), replace);
  }

  /** A same-document entry is committed: pushed (the entries after the current one go), or in the current one's place. */
  commit(entry: FakeEntry, replace: boolean): void {
    if (replace) this.entries[this.index] = entry;
    else {
      this.entries.splice(this.index + 1);
      this.entries.push(entry);
      this.index++;
    }
    this.shownUrls.push(entry.url);
    this.log.push(`${replace ? 'replace' : 'push'} ${new URL(entry.url).pathname}`);
    this.navigation?.dispatchEvent(new Event('currententrychange'));
  }

  /** Back/Forward lands on the entry at `index` (same document): the address bar shows it, then `popstate` (also with the Navigation API). */
  moveTo(index: number): void {
    this.index = index;
    this.shownUrls.push(this.current.url);
    this.navigation?.dispatchEvent(new Event('currententrychange'));
    if (this.navigation) this.dispatch('popstate', { state: this.history.state });
  }

  /** An entry as the navigator writes it on this tab's path — its state the Navigation API's, or `history.state` without it. */
  entryOf(url: string, state: unknown): FakeEntry {
    return this.navigation ? new FakeEntry(url, 'null', JSON.stringify(state)) : new FakeEntry(url, JSON.stringify(state));
  }

  /**
   * The user follows a plain link or sends a plain GET form (`<a href>`, `<form>` the navigator does not handle): a fresh activation,
   * the browser's `navigate` (push, `userInitiated`, no `info`) — and, unless a listener intercepted it, the document loads (`loads`).
   */
  follow(url: string): void {
    this.activate();
    if (this.navigation) return void this.navigation.navigate(url, {}, true);
    this.loads.push(`assign ${new URL(url, this.current.url).href}`);
  }

  /** The user clicks or types: a fresh user activation — their next Back or Forward can be cancelled (it uses it up). */
  activate(): void {
    this.#activated = true;
  }

  get current() {
    return this.entries[this.index]!;
  }

  get location(): NavigatorWindow['location'] {
    const url = new URL(this.current.url);
    return {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      assign: (to: string | URL) => void this.loads.push(`assign ${to}`),
      replace: (to: string | URL) => void this.loads.push(`replace ${to}`),
      reload: () => void this.loads.push('reload'),
    } as NavigatorWindow['location'];
  }

  scrollTo(x: number, y: number) {
    this.scrollX = x;
    this.scrollY = y;
    this.log.push(`scroll ${y}`);
  }

  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input, this.current.url).href;
    this.requests.push({ url, method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) } });
    return this.handler(url, init);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    this.#listeners.get(type)?.delete(listener);
  }

  /** How many listeners the window (`window:pageshow`) or its document (`document:visibilitychange`) has — what stays after a stop. */
  listening(target: `${'window' | 'document'}:${string}`): number {
    const [where, type] = target.split(':') as ['window' | 'document', string];
    return (where === 'window' ? this.#listeners : this.#documentListeners).get(type)?.size ?? 0;
  }

  dispatch(type: string, init: Record<string, unknown>) {
    const event = Object.assign(new Event(type), init);
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  /** The user closes the tab or reloads: `beforeunload` — returns whether the page asked to stay (the browser's question). */
  unload(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    for (const listener of this.#listeners.get('beforeunload') ?? []) listener(event);
    return event.defaultPrevented;
  }

  /**
   * The user's Back (the browser's button) within the same document. With the Navigation API: `navigate` (traverse,
   * `userInitiated`), cancelable only with a fresh activation (`activate()`, used up by it) — then, unless cancelled, the entry
   * changes and the handlers run. Without it: the entry changes, then `popstate` with its (deserialized) state.
   */
  back() {
    this.goTo(this.index - 1);
  }

  forward() {
    this.goTo(this.index + 1);
  }

  /** The user picks entry `index` from the browser's history menu (a long press on Back) — a Back or Forward over several entries. */
  goTo(index: number): void {
    if (this.navigation) {
      const cancelable = this.#activated;
      this.#activated = false;
      this.navigation.traverse(index, { userInitiated: true, cancelable });
      return;
    }
    this.index = index;
    this.shownUrls.push(this.current.url);
    this.dispatch('popstate', { state: this.history.state });
  }

  /** The user scrolls the window (and the regions) — the browser fires `scroll`. */
  scroll(y: number, ...regions: number[]) {
    this.scrollY = y;
    regions.forEach((top, index) => (this.regions[index]!.scrollTop = top));
    this.dispatch('scroll', {});
  }

  #resolve(url: string | URL | null | undefined): string {
    return url === null || url === undefined ? this.current.url : new URL(url, this.current.url).href;
  }
}

/** The features an adapter attaches to a navigator on this tab from the start: the History fallback, where it has no Navigation API. */
export const historyFeatures = (win: FakeWindow): Feature[] => (win.navigation ? [] : [historyFallback]);

export function boot(win: FakeWindow, initial: PageObject, options: Pick<ConstructorParameters<typeof Navigator>[0], 'cacheSize' | 'confirm' | 'features' | 'loadLayers' | 'viewTransition'> = {}) {
  const shown: PageObject[] = [];
  /** The region owner handed with each page rendered (islands live there). */
  const owners: RegionOwner[] = [];
  /** The layers handed with each render. */
  const stacks: (readonly Layer[])[] = [];
  /** Every render in order — an instant visit's placeholder too, which `shown` leaves out (it is no page). */
  const renders: { page: PageObject; placeholder: boolean; transition?: readonly string[] }[] = [];
  // Without the Navigation API, the adapter attaches the History fallback from the start (createMarmeonApp does).
  const features = win.navigation || options.features?.some((feature) => feature.name === 'history') ? options.features : [historyFallback, ...(options.features ?? [])];
  const navigator = new Navigator({
    initialPage: initial,
    window: win,
    render: async (next, { owner, layers, placeholder = false, transition }) => {
      renders.push({ page: next, placeholder, ...(transition ? { transition } : {}) });
      win.log.push(`render ${next.url}`);
      if (placeholder) return;
      shown.push(next);
      owners.push(owner);
      stacks.push(layers);
    },
    ...options,
    features,
  });
  const stop = navigator.start();
  const { layers: _layers, ...base } = initial;
  return {
    navigator,
    shown,
    owners,
    stacks,
    renders,
    stop,
    visible: () => shown.at(-1) ?? base,
    owner: () => owners.at(-1) ?? navigator.regionOwner,
    /** The layers on screen now — what the last render showed (the document's, before any). */
    layers: () => stacks.at(-1) ?? navigator.layers,
  };
}

/** Lets the async work of a popstate (a refetch, a render) finish. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Actions and optimistic patches of the page on screen, as an adapter uses them: the features attached to the navigator
 * (`use`), the page's patch target by its entry.
 */
export function withActions(navigator: Navigator) {
  // Attached at once — as `useAction`/`usePendingSubmissions` do when they render, before anything is sent.
  const run = navigator.use(actions);
  const patches = navigator.use(optimistic);
  const page = () => patches.target(navigator.regionOwner.entry!);
  return {
    action: (url: string, options?: ActionOptions) => run.run(url, options),
    optimistic: (patch: PropsPatch): OptimisticUpdate => ({ target: page(), patch }),
    reloading: (spec: ReloadSpec = {}): Reloading => ({ target: page(), spec }),
    get submissions() {
      return run.submissions().list;
    },
    subscribeSubmissions: (listener: () => void) => run.submissions().subscribe(listener),
  };
}

const PEEK = defineFeature('test-peek', (host) => host);

/** What `owner`'s history entry keeps of its islands (the slot `REGIONS`) — empty when the core let go of it. */
export function keptRegions(navigator: Navigator, owner: RegionOwner): ReadonlyMap<string, KeptRegion> {
  return navigator.use(PEEK).peek(REGIONS, owner.entry!) ?? new Map();
}


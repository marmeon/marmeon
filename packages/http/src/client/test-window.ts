/** The browser of the client core's tests: one tab's history, location, fetch and events — in memory. */
import { PAGE_HEADER, type PageObject } from '../page.ts';
import type { ActionOptions } from './action.ts';
import { actions } from './features/actions.ts';
import { optimistic } from './features/optimistic.ts';
import { Navigator, type NavigatorWindow, type ScrollRegion } from './navigation.ts';
import type { OptimisticUpdate, PropsPatch, Reloading, ReloadSpec } from './optimistic.ts';
import type { Layer } from './layer.ts';
import { REGIONS, type RegionOwner } from './owner.ts';
import { defineFeature } from './feature.ts';
import type { KeptRegion } from './region.ts';

export const ORIGIN = 'https://app.test';

export const page = (url: string, props: Record<string, unknown> = {}, component = 'pages/Show'): PageObject => ({ component, props, url, version: null });

export const pageResponse = (body: PageObject) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: 'true', 'content-type': 'application/json' } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/**
 * A live stream as the browser's `EventSource` (W6.10) — what the test makes the server say: `emit('hello', { seq })`,
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
 * One tab's history, as the browser keeps it: states are stored *serialized* (structured clone, written to
 * disk for session restore) — the test reads exactly what would end up there.
 */
export class FakeWindow implements NavigatorWindow {
  readonly entries: { url: string; state: string }[] = [];
  index = -1;
  readonly requests: { url: string; method: string; headers: Record<string, string> }[] = [];
  readonly loads: string[] = [];
  scrollX = 0;
  scrollY = 0;
  scrollRestoration: ScrollRestoration = 'auto';
  /** The page's `[scroll-region]` elements. */
  regions: ScrollRegion[] = [];
  /** `loading` while the document "still streams" (E49) — `finishLoading()` ends it. */
  readyState = 'complete';
  readonly #loaded = new Set<() => void>();
  readonly document: NonNullable<NavigatorWindow['document']>;
  XMLHttpRequest?: new () => XMLHttpRequest;
  /** The tab is shown or hidden (`hide()`, `show()`) — a live stream over HTTP/1.1 waits while hidden (E104). */
  visibilityState: DocumentVisibilityState = 'visible';
  /** The protocol the document came over (`nextHopProtocol`) — `''`: unknown. */
  protocol = 'h2';
  /** The live streams opened (W6.10), oldest first — `EventSource` of this tab. */
  readonly sources: FakeEventSource[] = [];
  EventSource?: new (url: string) => EventSource;
  readonly performance: NonNullable<NavigatorWindow['performance']>;
  readonly #documentListeners = new Map<string, Set<() => void>>();
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();
  handler: Handler = () => new Response('not found', { status: 404 });
  /** The browser's own dialogs (E64) — what they were asked, and what the "user" answers. */
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

  constructor(url: string) {
    this.entries.push({ url, state: 'null' });
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
        return JSON.parse(win.current.state);
      },
      pushState(state: unknown, _title: string, url?: string | URL | null) {
        win.entries.splice(win.index + 1);
        win.entries.push({ url: win.#resolve(url), state: JSON.stringify(state) });
        win.index++;
      },
      replaceState(state: unknown, _title: string, url?: string | URL | null) {
        win.entries[win.index] = { url: win.#resolve(url), state: JSON.stringify(state) };
      },
      // Like the browser's: asynchronous — the entry changes a task later, then popstate.
      go(delta: number) {
        setTimeout(() => {
          const index = win.index + delta;
          if (delta === 0 || index < 0 || index >= win.entries.length) return;
          win.index = index;
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

  /** Back within the same document: the browser fires popstate with the entry's (deserialized) state. */
  back() {
    this.index--;
    this.dispatch('popstate', { state: this.history.state });
  }

  forward() {
    this.index++;
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

export function boot(win: FakeWindow, initial: PageObject, options: Pick<ConstructorParameters<typeof Navigator>[0], 'cacheSize' | 'confirm' | 'features' | 'loadLayers'> = {}) {
  const shown: PageObject[] = [];
  /** The region owner handed with each page rendered (islands live there). */
  const owners: RegionOwner[] = [];
  /** The layers handed with each render (E53). */
  const stacks: (readonly Layer[])[] = [];
  /** Every render in order — an instant visit's placeholder too (E64), which `shown` leaves out (it is no page). */
  const renders: { page: PageObject; placeholder: boolean }[] = [];
  const navigator = new Navigator({
    initialPage: initial,
    window: win,
    render: async (next, { owner, layers, placeholder = false }) => {
      renders.push({ page: next, placeholder });
      if (placeholder) return;
      shown.push(next);
      owners.push(owner);
      stacks.push(layers);
    },
    ...options,
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
 * Actions and optimistic patches of the page on screen (E59), as an adapter uses them since Wave 5c step 4: the features
 * attached to the navigator (`use`), the page's patch target by its entry.
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


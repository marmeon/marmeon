/** The browser of the client core's tests: one tab's history, location, fetch and events — in memory. */
import { PAGE_HEADER, type PageObject } from '../page.ts';
import { Navigator, type NavigatorWindow, type ScrollRegion } from './navigation.ts';
import type { Layer } from './layer.ts';
import type { RegionOwner } from './region.ts';

export const ORIGIN = 'https://app.test';

export const page = (url: string, props: Record<string, unknown> = {}, component = 'pages/Show'): PageObject => ({ component, props, url, version: null });

export const pageResponse = (body: PageObject) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: 'true', 'content-type': 'application/json' } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

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
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();
  handler: Handler = () => new Response('not found', { status: 404 });

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
      addEventListener: (_type: 'DOMContentLoaded', listener: () => void) => void this.#loaded.add(listener),
    };
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

export function boot(win: FakeWindow, initial: PageObject, options: { cacheSize?: number } = {}) {
  const shown: PageObject[] = [];
  /** The region owner handed with each page rendered (islands live there). */
  const owners: RegionOwner[] = [];
  /** The layers handed with each render (E53). */
  const stacks: (readonly Layer[])[] = [];
  const navigator = new Navigator({
    initialPage: initial,
    window: win,
    render: async (next, { owner, layers }) => {
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
    stop,
    visible: () => shown.at(-1) ?? base,
    owner: () => owners.at(-1) ?? navigator.regionOwner,
    /** The layers on screen now — what the last render showed (the document's, before any). */
    layers: () => stacks.at(-1) ?? navigator.layers,
  };
}

/** Lets the async work of a popstate (a refetch, a render) finish. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

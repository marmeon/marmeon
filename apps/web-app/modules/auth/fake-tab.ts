import { PAGE_SCRIPT_ID, type PageObject } from '@marmeon/http/protocol';
import type { ActionOptions, OptimisticUpdate, Reloading } from '@marmeon/http/client';
import { actions, layers, optimistic } from '@marmeon/http/client/adapter';
import { loadHistoryFallback, Navigator, prefetchWith, type NavigatorWindow, type PropsPatch, type ReloadSpec } from '@marmeon/http/client/adapter';
import type { createHttpKernel } from '@marmeon/server';
import { expect } from 'vitest';

// The tab below is a browser without the Navigation API (History, popstate): the History fallback, as createMarmeonApp attaches it.
const HISTORY = await loadHistoryFallback();

/**
 * Back after signing out — the real app behind a simulated browser tab that keeps what a
 * browser keeps: history entries with their serialized `history.state` (on disk for session restore),
 * one live document per "document state" (pushState entries share their document), the back/forward cache
 * for documents that were not `no-store`, and an HTTP cache that Back/Forward prefers (Chromium does).
 * Each document runs the real client navigator of @marmeon/react against the app's kernel.
 */

export const ORIGIN = 'http://localhost';

type Kernel = ReturnType<typeof createHttpKernel>;

interface Entry {
  url: string;
  /** Serialized, as the browser stores it. */
  state: string;
  /** Entries pushed by a document share its document state (and so its document). */
  docState: number;
}

interface Doc {
  readonly docState: number;
  readonly navigator: Navigator;
  readonly listeners: Map<string, Set<(event: Event) => void>>;
  /** What the tab shows: the page the navigator rendered last. */
  visible: PageObject;
  /** The layers over it, as the navigator rendered them last. */
  layers: PageObject[];
  /** The document's response said `no-store`: it never enters the back/forward cache. */
  readonly noStore: boolean;
}

export class FakeTab {
  readonly #kernel: Kernel;
  readonly entries: Entry[] = [];
  index = -1;
  readonly #docs = new Map<number, Doc>();
  #current: Doc | undefined;
  #nextDocState = 1;
  /** Documents by final URL — only responses that may be stored. */
  readonly httpCache = new Map<string, Response>();
  readonly #cookies = new Map<string, string>();
  #pending: Promise<unknown>[] = [];
  /** What the server was asked, in order (`GET /x` for documents, `GET /x (visit)` for page JSON). */
  readonly requests: string[] = [];
  /** The flash messages the tab's documents fired, in order — `toast: <message>`: what the toasts would show. */
  readonly toasts: string[] = [];

  /** Whether documents that may be stored enter the back/forward cache (Chromium: not with an open WebSocket, …). */
  readonly #bfcache: boolean;

  constructor(kernel: Kernel, { bfcache }: { bfcache: boolean }) {
    this.#kernel = kernel;
    this.#bfcache = bfcache;
  }

  get visible(): PageObject {
    return this.#current!.visible;
  }

  /** The layers on screen over the page. */
  get layers(): PageObject[] {
    return this.#current!.layers;
  }

  /** The current document's navigator. */
  get navigator(): Navigator {
    return this.#current!.navigator;
  }

  /** An action of the current document: no navigation — then everything it started has finished. */
  async action(url: string, options?: ActionOptions) {
    const outcome = await this.navigator.use(actions).run(url, options);
    await this.idle();
    return outcome;
  }

  /** A patch of the page on screen for an action — the patches of its history entry, as the adapter makes them. */
  optimistic(patch: PropsPatch): OptimisticUpdate {
    return { target: this.navigator.use(optimistic).target(this.navigator.regionOwner.entry!), patch };
  }

  /** A reload of the page on screen once an action succeeded. */
  reloading(spec: ReloadSpec = {}): Reloading {
    return { target: this.navigator.use(optimistic).target(this.navigator.regionOwner.entry!), spec };
  }

  /**
   * A form sent in another tab of the same browser, whose redirect that tab has not followed yet: what it flashed waits in the
   * session for whichever answer the user is shown next.
   */
  async submitElsewhere(method: string, path: string, form: Record<string, string>): Promise<void> {
    const cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await this.#kernel.request(path, { method, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-xsrf-token': this.xsrf() }, body: new URLSearchParams(form) });
    expect(response.status).toBe(303);
  }

  /** The XSRF cookie's token (what the browser's JavaScript reads). */
  xsrf(): string {
    return decodeURIComponent(this.#cookies.get('XSRF-TOKEN') ?? '');
  }

  /** Signing out in another tab of the same browser: the cookies change, this document knows nothing of it. */
  async signOutElsewhere(): Promise<void> {
    await this.#request(new URL('/logout', ORIGIN).href, { method: 'POST' }, 'document');
  }

  /** A click or a form inside the top layer — the layer's own visit. */
  async layerVisit(url: string, options?: Parameters<Navigator['visit']>[1]): Promise<void> {
    await this.#current!.navigator.layers.at(-1)!.visit(url, options);
    await this.idle();
  }

  /** Typing a URL: a full page load in a new entry. */
  async open(path: string): Promise<void> {
    await this.#load(path, 'push');
  }

  /** A click on a `<Link>` or a form submit in the current document. */
  async visit(url: string, options?: Parameters<Navigator['visit']>[1]): Promise<void> {
    await this.#current!.navigator.visit(url, options);
    await this.idle();
  }

  /** A hovered `<Link prefetch>` in the current document. */
  async prefetch(url: string): Promise<void> {
    // As `<Link prefetch>` does: the prefetch code loads with the first one.
    await prefetchWith(this.#current!.navigator, url);
    await this.idle();
  }

  async back(): Promise<void> {
    const from = this.entries[this.index]!;
    this.index--;
    const to = this.entries[this.index]!;
    const live = this.#docs.get(to.docState);
    if (live && live === this.#current && to.docState === from.docState) {
      this.#dispatch(live, 'popstate', { state: JSON.parse(to.state) });
    } else if (live) {
      // Out of the back/forward cache: the document as it was left, JavaScript state included.
      this.#leave();
      this.#current = live;
      this.#dispatch(live, 'pageshow', { persisted: true });
    } else {
      await this.#load(to.url, 'traverse');
    }
    await this.idle();
  }

  /** Forward within the history — like `back()`. */
  async forward(): Promise<void> {
    const from = this.entries[this.index]!;
    this.index++;
    const to = this.entries[this.index]!;
    const live = this.#docs.get(to.docState);
    if (live && live === this.#current && to.docState === from.docState) this.#dispatch(live, 'popstate', { state: JSON.parse(to.state) });
    else await this.#load(to.url, 'traverse');
    await this.idle();
  }

  /** The reload button: the entry's URL loaded fully again (its state kept). */
  async reload(): Promise<void> {
    await this.#load(this.entries[this.index]!.url, 'reload');
    await this.idle();
  }

  /** Everything the navigators started (fetches, full loads) has finished. */
  async idle(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const pending = this.#pending;
      this.#pending = [];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  /** A full page load: GET without `x-marmeon`, the document comes from its HTML. */
  async #load(path: string, mode: 'push' | 'replace' | 'traverse' | 'reload'): Promise<void> {
    const url = new URL(path, this.entries[this.index]?.url ?? ORIGIN).href;
    // Back/Forward take a stored document when there is one — without asking the server. (A reload revalidates.)
    const cached = mode === 'traverse' ? this.httpCache.get(url) : undefined;
    const response = cached ? cached.clone() : await this.#request(url, { method: 'GET' }, 'document');
    const finalUrl = cached ? url : response.url;
    const noStore = (response.headers.get('cache-control') ?? '').includes('no-store');
    if (!cached && !noStore) this.httpCache.set(finalUrl, response.clone());
    const page = pageFromHtml(await response.text());

    this.#leave();
    if (mode === 'push') {
      this.entries.splice(this.index + 1);
      this.entries.push({ url: finalUrl, state: 'null', docState: this.#nextDocState++ });
      this.index++;
    } else {
      const entry = this.entries[this.index]!;
      // A redirect while loading the entry: it is that page now, its old state does not belong to it.
      this.entries[this.index] = { url: finalUrl, state: finalUrl === entry.url ? entry.state : 'null', docState: mode === 'replace' ? this.#nextDocState++ : entry.docState };
    }
    this.#boot(page, this.entries[this.index]!.docState, noStore);
  }

  /** The current document goes away: into the back/forward cache, unless it was `no-store` (or the cache is off). */
  #leave(): void {
    const doc = this.#current;
    if (doc && (doc.noStore || !this.#bfcache)) this.#docs.delete(doc.docState);
  }

  #boot(page: PageObject, docState: number, noStore: boolean): void {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const doc: Doc = {
      docState,
      listeners,
      noStore,
      visible: page,
      layers: page.layers ?? [],
      navigator: new Navigator({
        initialPage: page,
        // A deep link's document: the layers attached before it is shown, as an adapter does (createMarmeonApp loads them
        // first). Any other document loads them when an answer is a layer.
        features: page.layers ? [HISTORY, layers] : [HISTORY],
        window: this.#window(listeners),
        render: async (next, { layers }) => {
          doc.visible = next;
          doc.layers = layers.map((layer) => layer.page);
        },
      }),
    };
    this.#docs.set(docState, doc);
    this.#current = doc;
    // The layout's toasts (`useFlash('toast', …)`): each message once.
    doc.navigator.on('flash', (message) => this.toasts.push(`${message.key}: ${(message.data as { message?: string }).message}`));
    doc.navigator.start();
  }

  /** `window`, as a document of this tab sees it. */
  #window(listeners: Doc['listeners']): NavigatorWindow {
    // oxlint-disable-next-line typescript/no-this-alias -- the history object's getters below have their own `this`
    const tab = this;
    const entry = () => tab.entries[tab.index]!;
    const navigate = (to: string | URL, mode: 'push' | 'replace') => void tab.#pending.push(tab.#load(String(to), mode));
    return {
      history: {
        get state() {
          return JSON.parse(entry().state);
        },
        pushState(state: unknown, _title: string, url?: string | URL | null) {
          const { docState } = entry();
          tab.entries.splice(tab.index + 1);
          tab.entries.push({ url: new URL(url ?? entry().url, entry().url).href, state: JSON.stringify(state), docState });
          tab.index++;
        },
        replaceState(state: unknown, _title: string, url?: string | URL | null) {
          tab.entries[tab.index] = { ...entry(), url: new URL(url ?? entry().url, entry().url).href, state: JSON.stringify(state) };
        },
        // Closing a layer goes back — a task later, like the browser's.
        go(delta: number) {
          if (delta === -1) tab.#pending.push(new Promise((resolve) => setTimeout(resolve, 0)).then(() => tab.back()));
        },
      } as NavigatorWindow['history'],
      get location() {
        const url = new URL(entry().url);
        return {
          href: url.href,
          origin: url.origin,
          pathname: url.pathname,
          search: url.search,
          assign: (to: string | URL) => navigate(to, 'push'),
          replace: (to: string | URL) => navigate(to, 'replace'),
          reload: () => void tab.#pending.push(tab.#load(entry().url, 'reload')),
        } as NavigatorWindow['location'];
      },
      scrollX: 0,
      scrollY: 0,
      scrollTo: () => {},
      fetch: (input, init) => {
        const request = tab.#request(new URL(input, entry().url).href, init ?? {}, 'visit');
        tab.#pending.push(request);
        return request;
      },
      addEventListener: (type, listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type, listener) => void listeners.get(type)?.delete(listener),
    };
  }

  #dispatch(doc: Doc, type: string, init: Record<string, unknown>): void {
    const event = Object.assign(new Event(type), init);
    for (const listener of doc.listeners.get(type) ?? []) listener(event);
  }

  /** `fetch` with this tab's cookies, following redirects like a browser (303 → GET). */
  async #request(url: string, init: RequestInit, kind: 'document' | 'visit'): Promise<Response> {
    let target = new URL(url);
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    for (let hop = 0; hop < 10; hop++) {
      this.requests.push(`${method} ${target.pathname}${kind === 'visit' ? ' (visit)' : ''}`);
      const cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await this.#kernel.request(target.pathname + target.search, { method, headers: { ...headers, ...(cookie ? { cookie } : {}) }, body });
      for (const line of response.headers.getSetCookie()) {
        const [pair, ...attributes] = line.split(';');
        const [name, value] = [pair!.slice(0, pair!.indexOf('=')), pair!.slice(pair!.indexOf('=') + 1)];
        if (attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || value === '') this.#cookies.delete(name);
        else this.#cookies.set(name, value);
      }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          delete headers['content-type'];
        }
        target = new URL(location, target);
        continue;
      }
      Object.defineProperty(response, 'url', { value: target.href });
      return response;
    }
    throw new Error(`Too many redirects from ${url}`);
  }
}

export function pageFromHtml(html: string): PageObject {
  const match = new RegExp(`<script type="application/json" id="${PAGE_SCRIPT_ID}">(.*?)</script>`, 's').exec(html);
  if (!match) throw new Error(`No page script in:\n${html.slice(0, 500)}`);
  return JSON.parse(match[1]!) as PageObject;
}

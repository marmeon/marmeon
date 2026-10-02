import { NO_STORE } from '@bespokecore/auth';
import { LOCATION_HEADER, PAGE_HEADER, PAGE_SCRIPT_ID, type PageObject } from '@bespokecore/http/page';
import { actions, layers, Navigator, optimistic, prefetchWith, type ActionOptions, type NavigatorWindow, type OptimisticUpdate, type PropsPatch, type Reloading, type ReloadSpec } from '@bespokecore/http/client';
import { createHttpKernel } from '@bespokecore/server';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';

/**
 * Back after signing out (W5 step 3, E36) — the real app behind a simulated browser tab that keeps what a
 * browser keeps: history entries with their serialized `history.state` (on disk for session restore),
 * one live document per "document state" (pushState entries share their document), the back/forward cache
 * for documents that were not `no-store`, and an HTTP cache that Back/Forward prefers (Chromium does — a
 * document without `Cache-Control` came back from it, without a request, in the browser check).
 * Each document runs the real client navigator of @bespokecore/react against the app's kernel.
 */

const ORIGIN = 'http://localhost';

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
  /** The layers over it (E53), as the navigator rendered them last. */
  layers: PageObject[];
  /** The document's response said `no-store`: it never enters the back/forward cache. */
  readonly noStore: boolean;
}

class FakeTab {
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
  /** The flash messages the tab's documents fired (E60), in order — `toast: <message>`: what the toasts would show. */
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

  /** The layers on screen over the page (E53). */
  get layers(): PageObject[] {
    return this.#current!.layers;
  }

  /** The current document's navigator. */
  get navigator(): Navigator {
    return this.#current!.navigator;
  }

  /** An action of the current document (E59): no navigation — then everything it started has finished. */
  async action(url: string, options?: ActionOptions) {
    const outcome = await this.navigator.use(actions).run(url, options);
    await this.idle();
    return outcome;
  }

  /** A patch of the page on screen for an action (E59) — the patches of its history entry, as the adapter makes them. */
  optimistic(patch: PropsPatch): OptimisticUpdate {
    return { target: this.navigator.use(optimistic).target(this.navigator.regionOwner.entry!), patch };
  }

  /** A reload of the page on screen once an action succeeded. */
  reloading(spec: ReloadSpec = {}): Reloading {
    return { target: this.navigator.use(optimistic).target(this.navigator.regionOwner.entry!), spec };
  }

  /**
   * A form sent in another tab of the same browser, whose redirect that tab has not followed yet: what it flashed waits in the
   * session (E60) for whichever answer the user is shown next.
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
    // As `<Link prefetch>` does: the prefetch code loads with the first one (E74).
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

  /** A full page load: GET without `x-bespoke`, the document comes from its HTML. */
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
        // A deep link's document: the layers attached before it is shown, as an adapter does (createBespokeApp loads them first,
        // E71). Any other document loads them when an answer is a layer.
        features: page.layers ? [layers] : [],
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
        // Closing a layer goes back (E53) — a task later, like the browser's.
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

function pageFromHtml(html: string): PageObject {
  const match = new RegExp(`<script type="application/json" id="${PAGE_SCRIPT_ID}">(.*?)</script>`, 's').exec(html);
  if (!match) throw new Error(`No page script in:\n${html.slice(0, 500)}`);
  return JSON.parse(match[1]!) as PageObject;
}

let app: TestApp;
let tab: FakeTab;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
  tab = new FakeTab(createHttpKernel(app.application), { bfcache: true });
});

/** Signs in, creates an API token (its plain text is shown once) and signs out — the attack's setup. */
async function createTokenThenSignOut() {
  const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com' });
  await tab.open('/login');
  await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
  expect(tab.visible.component).toBe('user-profile/Show');
  await tab.visit('/settings/tokens');
  // The form is a layer over the list; its answer — the plain text — replaces it, shown once (E53).
  await tab.visit('/settings/tokens/create', { layer: true });
  await tab.layerVisit('/settings/tokens', { method: 'post', data: { name: 'Backup script', abilities: ['users:read'] } });
  expect(tab.layers.map((layer) => layer.component)).toEqual(['auth/NewAccessToken']);
  const plainText = tab.layers[0]!.props.plainText as string;
  expect(plainText).toMatch(/^bc_\d+\|/);
  await tab.visit('/logout', { method: 'post' });
  expect(tab.visible.component).toBe('auth/Login');
  return { ada, plainText };
}

/** Everything a page (and the layers over it) shows that would give the signed-out user away. */
const leaks = (page: PageObject, plainText: string) => {
  const shown = JSON.stringify([page, tab.layers]);
  return [plainText, 'ada@example.com', 'Ada Lovelace'].filter((secret) => shown.includes(secret));
};

describe('Back after signing out (E36)', () => {
  it.each([
    ['with the back/forward cache', true],
    ['without it — Back takes documents from the HTTP cache', false],
  ])('counter-check of the attack (%s): Back after signing out shows neither the token nor the profile — the login page', async (_, bfcache) => {
    tab = new FakeTab(createHttpKernel(app.application), { bfcache });
    const { plainText } = await createTokenThenSignOut();
    // Back through every entry: the token layer's (the plain text), the list, the profile, /login.
    while (tab.index > 0) {
      await tab.back();
      expect(leaks(tab.visible, plainText), `Back to ${tab.entries[tab.index]!.url} shows ${tab.visible.component}`).toEqual([]);
      expect(tab.visible.component).toBe('auth/Login');
    }
  });

  it.each([
    ['with the back/forward cache', true],
    ['without it — Back takes documents from the HTTP cache', false],
  ])('counter-check, full page loads (%s): Back to a page loaded fully before signing out asks the server again', async (_, bfcache) => {
    tab = new FakeTab(createHttpKernel(app.application), { bfcache });
    const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com' });
    await tab.open('/login');
    await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
    await tab.open('/settings/security'); // typed into the address bar: each one its own document
    expect(tab.visible.props).toMatchObject({ email: 'ada@example.com' });
    await tab.open('/users/me');
    await tab.visit('/logout', { method: 'post' });

    const asked = tab.requests.length;
    while (tab.index > 0) {
      await tab.back();
      expect(leaks(tab.visible, 'no token here'), `Back to ${tab.entries[tab.index]!.url} shows ${tab.visible.component}`).toEqual([]);
    }
    // Every protected document was requested again (and redirected to the login page), none came from a cache.
    expect(tab.requests.slice(asked)).toEqual(expect.arrayContaining([`GET /users/${ada.id}`, 'GET /settings/security']));
  });

  it('a page prefetched while signed in (W5 step 6) is gone with the sign-out — neither Back nor a visit shows it', async () => {
    const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com' });
    await tab.open('/login');
    await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
    await tab.visit('/settings/security'); // a fresh sign-in counts as a confirmed password: the page itself
    await tab.visit(`/users/${ada.id}`);
    await tab.prefetch('/settings/security'); // hovered, never clicked
    expect(tab.requests.at(-1)).toBe('GET /settings/security (visit)');
    await tab.visit('/logout', { method: 'post' });
    expect(tab.visible.component).toBe('auth/Login');

    const asked = tab.requests.length;
    await tab.visit('/settings/security');
    expect(leaks(tab.visible, 'no token here')).toEqual([]);
    expect(tab.visible.component).toBe('auth/Login');
    expect(tab.requests.slice(asked)).toEqual(['GET /settings/security (visit)', 'GET /login (visit)']); // the server was asked
    while (tab.index > 0) {
      await tab.back();
      expect(leaks(tab.visible, 'no token here'), `Back to ${tab.entries[tab.index]!.url}`).toEqual([]);
    }
  });

  it('keeps no props in history.state — nothing of the token or the profile is written to disk', async () => {
    const { plainText } = await createTokenThenSignOut();
    expect(tab.entries.length).toBeGreaterThan(2);
    for (const { state } of tab.entries) {
      expect(state).not.toContain(plainText);
      expect(state).not.toContain('ada@example.com');
      // A layer's entry adds its depth and the keys beneath it — never what it shows.
      // `index`: the entry's position (E64, the navigation guard) — a number.
      if (state !== 'null') expect(Object.keys(JSON.parse(state)).filter((key) => key !== 'layer').sort()).toEqual(['component', 'index', 'key', 'scroll', 'url']);
    }
  });

  it('signs in and out with a full page load: the server answers the visit with 409 + x-bespoke-location', async () => {
    const { ada } = await createTokenThenSignOut();
    // The 303s of login and logout never reach the client as page JSON: each is followed by a document load.
    expect(tab.requests).toEqual([
      'GET /login',
      'POST /login (visit)', // → 409, x-bespoke-location: /users/me
      'GET /users/me',
      `GET /users/${ada.id}`,
      `GET /users/${ada.id} (visit)`, // the profile's deferred activity, loaded after the page (a partial reload)
      'GET /settings/tokens (visit)',
      'GET /settings/tokens/create (visit)', // the form: a layer
      'POST /settings/tokens (visit)', // its answer: the plain text, a layer shown once
      'POST /logout (visit)', // → 409, x-bespoke-location: /login, Clear-Site-Data: "cache"
      'GET /login',
    ]);
  });

  it('never stores what a signed-in user saw: no document of theirs is in the HTTP cache', async () => {
    await createTokenThenSignOut();
    expect([...tab.httpCache.keys()]).toEqual([`${ORIGIN}/login`]);
  });
});

describe('Cache headers', () => {
  it('marks every answer for a signed-in user no-store, private — pages, page JSON, redirects, error pages', async () => {
    const ada = await app.factory(UserFactory).create();
    const signedIn = app.actingAs(ada);
    await signedIn.get(`/users/${ada.id}`).assertOk().assertHeader('cache-control', NO_STORE);
    await signedIn.navigating().get(`/users/${ada.id}`).assertOk().assertHeader('cache-control', NO_STORE);
    await signedIn.get('/users/me').assertRedirect().assertHeader('cache-control', NO_STORE);
    await signedIn.get('/users/999999').assertNotFound().assertHeader('cache-control', NO_STORE);
  });

  it('leaves guests’ answers alone', async () => {
    const response = await app.get('/login').assertOk();
    expect(response.headers.get('cache-control')).toBeNull();
  });

  it('varies pages on x-bespoke (and the partial-reload and prefetch headers, and the language): the HTML document and the page JSON of one URL are two cache entries', async () => {
    const html = await app.get('/login').assertOk();
    const json = await app.navigating().get('/login').assertOk();
    for (const response of [html, json]) {
      expect(response.headers.get('vary')?.split(', ')).toEqual([PAGE_HEADER, 'x-bespoke-region', 'x-bespoke-partial-component', 'x-bespoke-partial-data', 'x-bespoke-partial-except', 'purpose', 'x-bespoke-once', 'x-bespoke-once-scope', 'accept-language']);
    }
  });

  it('answers a sign-out visit with a full page load and Clear-Site-Data; a plain form post keeps its 303', async () => {
    const ada = await app.factory(UserFactory).create();
    const visit = await app.actingAs(ada).navigating().post('/logout').assertStatus(409).assertGuest();
    expect(visit.headers.get(LOCATION_HEADER)).toBe('/login');
    expect(visit.headers.get('clear-site-data')).toBe('"cache"');
    expect(visit.headers.get('location')).toBeNull();

    const form = await app.actingAs(ada).post('/logout').assertStatus(303).assertRedirect('/login');
    expect(form.headers.get('clear-site-data')).toBe('"cache"');
  });

  it('answers a sign-in visit with a full page load to where the login was headed', async () => {
    const ada = await app.factory(UserFactory).create();
    const visit = await app.navigating().post('/login', { json: { email: ada.email, password: 'password' } }).assertStatus(409).assertAuthenticated(ada);
    expect(visit.headers.get(LOCATION_HEADER)).toBe('/users/me');
    expect(visit.headers.get('clear-site-data')).toBeNull(); // only signing out clears the HTTP cache

    // A failed login changes nobody: an ordinary visit answer (back to the form, with errors).
    await app.navigating().post('/login', { json: { email: ada.email, password: 'wrong' } }).assertStatus(303);
  });

  it('does not reload for a "keep me signed in" sign-in — the same person continues', async () => {
    const ada = await app.factory(UserFactory).create();
    const login = await app.post('/login', { form: { email: ada.email, password: 'password', remember: 'on' } });
    // A new browser session (no session cookie), the remember-me cookie signs in during an ordinary visit.
    await app.withCookie('remember_web', login.cookie('remember_web')!).navigating().get(`/users/${ada.id}`).assertOk().assertAuthenticated(ada);
  });
});

describe('Layers in a tab (E53) — the real app, the real navigator', () => {
  /** Signed in on Ada's profile, its deferred activity loaded. */
  async function onProfile() {
    const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com' });
    await tab.open('/login');
    await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
    expect(tab.visible.component).toBe('user-profile/Show');
    return ada;
  }

  it('counter-check: Back closes the layer, not the page — no request, the profile’s deferred props not asked again; Forward opens it from memory', async () => {
    const ada = await onProfile();
    const entries = tab.entries.length;
    const asked = tab.requests.length;
    await tab.visit(`/users/${ada.id}/edit`, { layer: true });
    expect(tab.layers.map((layer) => layer.component)).toEqual(['user-profile/Edit']);
    expect(tab.entries.length).toBe(entries + 1);
    expect(tab.visible.component).toBe('user-profile/Show');

    await tab.back();
    expect(tab.layers).toEqual([]);
    expect(tab.visible.component).toBe('user-profile/Show');
    await tab.forward();
    expect(tab.layers.map((layer) => layer.component)).toEqual(['user-profile/Edit']);
    // One request in all — the layer's. Not the profile again, not its deferred activity.
    expect(tab.requests.slice(asked)).toEqual([`GET /users/${ada.id}/edit (visit)`]);
    for (const { state } of tab.entries) expect(state).not.toContain('ada@example.com');
  });

  it('a reload on the layer’s URL shows the declared base and the layer — from one document', async () => {
    const ada = await onProfile();
    await tab.visit('/people');
    await tab.visit(`/users/${ada.id}/edit`, { layer: true });
    expect(tab.visible.component).toBe('user-profile/People'); // opened over the page on screen (Max, 02.10.)

    const asked = tab.requests.length;
    await tab.reload();
    // One document (then the base's deferred activity, as after any full load of the profile).
    expect(tab.requests.slice(asked)).toEqual([`GET /users/${ada.id}/edit`, `GET /users/${ada.id} (visit)`]);
    expect(tab.visible.component).toBe('user-profile/Show'); // its declared base now
    expect(tab.layers.map((layer) => layer.component)).toEqual(['user-profile/Edit']);
  });

  it('saving in the layer closes it — Back in the history — and the profile beneath shows the new name', async () => {
    const ada = await onProfile();
    const entries = tab.entries.length;
    await tab.visit(`/users/${ada.id}/edit`, { layer: true });
    await tab.layerVisit(`/users/${ada.id}`, { method: 'put', data: { name: 'Ada King', bio: '' } });
    expect(tab.layers).toEqual([]);
    expect(tab.index).toBe(entries - 1);
    expect(tab.visible.props).toMatchObject({ profile: { name: 'Ada King' } });
    // The close delivered it (E60): once, though the profile beneath reloaded after it.
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
  });

  it('counter-check: after signing out, Back shows no layer — neither the plain text of a token nor the profile form', async () => {
    const ada = await onProfile();
    await tab.visit(`/users/${ada.id}/edit`, { layer: true });
    // Signed out underneath (the page's visit, as the session expiring would): a full page load.
    await tab.visit('/logout', { method: 'post' });
    expect(tab.visible.component).toBe('auth/Login');
    while (tab.index > 0) {
      await tab.back();
      expect(tab.layers, `Back to ${tab.entries[tab.index]!.url}`).toEqual([]);
      expect(leaks(tab.visible, 'no token here')).toEqual([]);
    }
  });
});

describe('Actions in a tab (E59) — the real app, the real navigator', () => {
  type Link = { id: number; label: string };
  const linksOf = (page: PageObject) => (page.props as { profile: { links: Link[] } }).profile.links.map((link) => link.label);
  const without = (label: string) => (props: Readonly<Record<string, unknown>>) => {
    const profile = props.profile as { links: Link[] };
    return { profile: { ...profile, links: profile.links.filter((link) => link.label !== label) } };
  };

  async function onProfileWithLinks() {
    const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com', email_verified_at: new Date() });
    const { ProfileLinkFactory } = await import('../user-profile/factories/ProfileLinkFactory.ts');
    const [notes, blog] = await Promise.all([
      app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' }),
      app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Blog' }),
    ]);
    await tab.open('/login');
    await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
    expect(linksOf(tab.visible).sort()).toEqual(['Blog', 'Notes']);
    return { ada, notes: notes!, blog: blog! };
  }

  it('removes a link without navigating: the patch at once, then the profile from the server, its toast with the answer — no history entry', async () => {
    const { ada, notes } = await onProfileWithLinks();
    const entries = JSON.stringify(tab.entries);
    const outcome = await tab.action(`/users/${ada.id}/links/${notes.id}`, {
      method: 'delete',
      optimistic: tab.optimistic(without('Notes')),
      reload: tab.reloading({ only: ['profile'] }),
    });
    expect(outcome).toMatchObject({ ok: true, kind: 'redirect', redirect: `/users/${ada.id}`, flash: [{ key: 'toast', data: { message: 'Link removed.' } }] });
    expect(linksOf(tab.visible)).toEqual(['Blog']);
    expect(tab.toasts).toEqual(['toast: Link removed.']);
    expect(tab.requests.slice(-2)).toEqual([`DELETE /users/${ada.id}/links/${notes.id} (visit)`, `GET /users/${ada.id} (visit)`]);
    expect(JSON.stringify(tab.entries)).toBe(entries);
  });

  it('someone else’s link: 404 — the patch goes, the list is as it was', async () => {
    const { ada, notes } = await onProfileWithLinks();
    const alan = await app.factory(UserFactory).create();
    const { ProfileLinkFactory } = await import('../user-profile/factories/ProfileLinkFactory.ts');
    const theirs = (await app.factory(ProfileLinkFactory).create({ user_id: alan.id, label: 'Theirs' }))!;
    // Ada's user id with Alan's link: the scoped binding answers 404 (no IDOR).
    const outcome = await tab.action(`/users/${ada.id}/links/${theirs.id}`, { method: 'delete', optimistic: tab.optimistic(without('Notes')) });
    expect(outcome).toMatchObject({ ok: false, kind: 'exception', exception: { type: 'server', status: 404 } });
    expect(linksOf(tab.visible).sort()).toEqual(['Blog', 'Notes']);
    expect(notes).toBeDefined();
  });

  it('counter-check: signed out in another tab, the action is a 401 — its patch goes and stays gone (Back, Forward), nothing is retried', async () => {
    const { ada, notes } = await onProfileWithLinks();
    await tab.visit('/people');
    await tab.back();
    await tab.signOutElsewhere();
    const asked = tab.requests.length;
    const outcome = await tab.action(`/users/${ada.id}/links/${notes.id}`, {
      method: 'delete',
      optimistic: tab.optimistic(without('Notes')),
      reload: tab.reloading({ only: ['profile'] }),
    });
    expect(outcome).toMatchObject({ ok: false, kind: 'exception', exception: { type: 'server', status: 401 } });
    expect(tab.requests.slice(asked)).toEqual([`DELETE /users/${ada.id}/links/${notes.id} (visit)`]);
    expect(linksOf(tab.visible).sort()).toEqual(['Blog', 'Notes']);
    await tab.forward();
    await tab.back();
    expect(linksOf(tab.visible).sort()).toEqual(['Blog', 'Notes']);
    await app.assertDatabaseHas('profile_links', { id: notes.id });
  });
});


describe('Flash in a tab (E60) — exactly once, from whichever answer is shown', () => {
  async function onProfile() {
    const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com', email_verified_at: new Date() });
    await tab.open('/login');
    await tab.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
    expect(tab.visible.component).toBe('user-profile/Show');
    return ada;
  }
  const save = (ada: { id: number }, name: string) => tab.visit(`/users/${ada.id}`, { method: 'put', data: { name, bio: '' } });

  it('a save’s toast fires once — not again for a partial reload, a full reload of the page, Back or Forward', async () => {
    const ada = await onProfile();
    await save(ada, 'Ada King');
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
    await tab.navigator.reload({ only: ['activity'] });
    await tab.idle();
    await tab.navigator.reload();
    await tab.idle();
    await tab.visit('/people');
    await tab.back();
    await tab.forward();
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
  });

  it('counter-check: two saves with the same message are two toasts', async () => {
    const ada = await onProfile();
    await save(ada, 'Ada King');
    await save(ada, 'Ada King');
    expect(tab.toasts).toEqual(['toast: Profile saved.', 'toast: Profile saved.']);
  });

  it('counter-check: a hover-prefetch while a message waits takes none — the click asks the server, and the toast comes with that page', async () => {
    const ada = await onProfile();
    // Another tab saved; its redirect not followed yet: the message waits in the session.
    await tab.submitElsewhere('PUT', `/users/${ada.id}`, { name: 'Ada King', bio: '' });
    await tab.prefetch('/people');
    expect(tab.toasts).toEqual([]);
    const asked = tab.requests.length;
    await tab.visit('/people');
    expect(tab.requests.slice(asked)[0]).toBe('GET /people (visit)'); // not the prefetched page: it said a message waits
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
  });

  it('counter-check: a layer’s answer delivers a waiting message too — the toast shows over the layer, not lost in it', async () => {
    const ada = await onProfile();
    await tab.submitElsewhere('PUT', `/users/${ada.id}`, { name: 'Ada King', bio: '' });
    await tab.visit(`/users/${ada.id}/edit`, { layer: true });
    expect(tab.layers.map((layer) => layer.component)).toEqual(['user-profile/Edit']);
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
    await tab.back();
    expect(tab.toasts).toEqual(['toast: Profile saved.']);
  });

  it('counter-check: an action delivers its message with the answer — and no reload after it brings it again', async () => {
    const ada = await onProfile();
    const outcome = await tab.action(`/users/${ada.id}/links`, { data: { label: 'Blog', url: 'https://blog.example' }, reload: tab.reloading({ only: ['profile'] }) });
    expect(outcome).toMatchObject({ ok: true, kind: 'redirect', flash: [{ key: 'toast', data: { kind: 'success', message: 'Link added.' } }] });
    expect(tab.toasts).toEqual(['toast: Link added.']);
    await tab.navigator.reload();
    await tab.idle();
    await tab.visit('/people');
    expect(tab.toasts).toEqual(['toast: Link added.']);
  });

  it('signing out: the message survives the 409 and shows on the login page — once', async () => {
    await onProfile();
    await tab.visit('/logout', { method: 'post' });
    expect(tab.visible.component).toBe('auth/Login');
    expect(tab.toasts).toEqual(['toast: You have been signed out.']);
  });
});

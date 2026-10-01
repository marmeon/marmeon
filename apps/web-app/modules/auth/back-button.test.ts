import { NO_STORE } from '@bespokecore/auth';
import { LOCATION_HEADER, PAGE_HEADER, PAGE_SCRIPT_ID, type PageObject } from '@bespokecore/http/page';
import { Navigator, type NavigatorWindow } from '@bespokecore/http/client';
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

  /** Whether documents that may be stored enter the back/forward cache (Chromium: not with an open WebSocket, …). */
  readonly #bfcache: boolean;

  constructor(kernel: Kernel, { bfcache }: { bfcache: boolean }) {
    this.#kernel = kernel;
    this.#bfcache = bfcache;
  }

  get visible(): PageObject {
    return this.#current!.visible;
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
    await this.#current!.navigator.prefetch(url);
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
      navigator: new Navigator({
        initialPage: page,
        window: this.#window(listeners),
        render: async (next) => {
          doc.visible = next;
        },
      }),
    };
    this.#docs.set(docState, doc);
    this.#current = doc;
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
  await tab.visit('/settings/tokens', { method: 'post', data: { name: 'Backup script', abilities: ['users:read'] } });
  const plainText = tab.visible.props.plainText as string;
  expect(plainText).toMatch(/^bc_\d+\|/);
  await tab.visit('/logout', { method: 'post' });
  expect(tab.visible.component).toBe('auth/Login');
  return { ada, plainText };
}

/** Everything a page shows that would give the signed-out user away. */
const leaks = (page: PageObject, plainText: string) => {
  const shown = JSON.stringify(page);
  return [plainText, 'ada@example.com', 'Ada Lovelace'].filter((secret) => shown.includes(secret));
};

describe('Back after signing out (E36)', () => {
  it.each([
    ['with the back/forward cache', true],
    ['without it — Back takes documents from the HTTP cache', false],
  ])('counter-check of the attack (%s): Back after signing out shows neither the token nor the profile — the login page', async (_, bfcache) => {
    tab = new FakeTab(createHttpKernel(app.application), { bfcache });
    const { plainText } = await createTokenThenSignOut();
    // Back through every entry: /settings/tokens (the token page replaced the list), the profile, /login.
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
      if (state !== 'null') expect(Object.keys(JSON.parse(state)).sort()).toEqual(['component', 'key', 'scroll', 'url']);
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
      'POST /settings/tokens (visit)',
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
      expect(response.headers.get('vary')?.split(', ')).toEqual([PAGE_HEADER, 'x-bespoke-partial-component', 'x-bespoke-partial-data', 'x-bespoke-partial-except', 'purpose', 'accept-language']);
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

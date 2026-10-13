import { DOCUMENT_HEADER, SESSION_PATH } from '@marmeon/http';
import { PAGE_HEADER, PAGE_SCRIPT_ID, type PageObject } from '@marmeon/http/page';
import { loadHistoryFallback, Navigator, tabSync, type NavigatorWindow } from '@marmeon/http/client';
import { createHttpKernel } from '@marmeon/server';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';

// The tabs below are browsers without the Navigation API (History, popstate): the History fallback, as createMarmeonApp attaches it.
const HISTORY = await loadHistoryFallback();

/**
 * Tab sync against the real app: the session's epoch on every page and at `/_marmeon/session`, flash
 * messages bound to the document that flashed them — and two tabs of one browser (one cookie jar, one set of channels), each
 * document running the real client navigator with the `tabSync` feature, as `createMarmeonApp` attaches it.
 */

const ORIGIN = 'http://localhost';
type Kernel = ReturnType<typeof createHttpKernel>;

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

const german = { 'accept-language': 'de-DE,de;q=0.9' };
const referer = (path: string) => ({ referer: `${ORIGIN}${path}` });

/** What `/_marmeon/session` says for a client (its cookie). */
const epochFor = async (client: TestApp) => ((await client.get(SESSION_PATH).assertOk()).json() as { epoch: string }).epoch;

/** Signs in with the form — a client with the session's cookie. */
async function signIn(email = 'ada@example.com'): Promise<TestApp> {
  const login = await app.post('/login', { form: { email, password: 'password' }, headers: referer('/login') }).assertRedirect();
  return app.withCookie('marmeon_session', login.cookie('marmeon_session')!);
}

describe('the session’s epoch', () => {
  it('opaque, and the same for every page of one signed-in session — flash messages and other writes leave it as it is', async () => {
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const browser = await signIn();
    const first = (await browser.navigating().get('/dashboard').assertOk()).page()!.epoch!;
    expect(first).toMatch(/^[\w-]{22}$/);
    expect(await epochFor(browser)).toBe(first);
    // A write that flashes (the profile saved), its redirect followed with the message, a partial reload: the same epoch.
    await browser.put(`/users/${ada.public_id}`, { json: { name: 'Ada King', bio: '' } }).assertRedirect();
    const shown = await browser.navigating().get(`/users/${ada.public_id}`).assertOk().assertFlash('toast');
    expect(shown.page()!.epoch).toBe(first);
    expect((await browser.navigating().get('/people').assertOk()).page()!.epoch).toBe(first);
  });

  it('changes when someone signs in, signs out or signs in again — and with the language; a failed sign-in leaves it', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const guest = await epochFor(app);
    expect((await app.navigating().get('/login').assertOk()).page()!.epoch).toBe(guest);
    // A failed sign-in leaves a guest session behind (its errors): still a guest's epoch — the other tabs need not reload.
    const failed = await app.post('/login', { form: { email: 'ada@example.com', password: 'wrong' }, headers: referer('/login') }).assertRedirect('/login');
    expect(await epochFor(app.withCookie('marmeon_session', failed.cookie('marmeon_session')!))).toBe(guest);

    const once = await signIn();
    const signedIn = await epochFor(once);
    expect(signedIn).not.toBe(guest);
    const twice = await signIn();
    const again = await epochFor(twice);
    expect(again).not.toBe(signedIn); // the same user, another session

    // The language of the second session.
    await twice.post('/locale', { form: { locale: 'de' }, headers: referer('/dashboard') }).assertRedirect();
    expect(await epochFor(twice)).not.toBe(again);

    const out = await once.post('/logout', { headers: referer('/dashboard') }).assertRedirect('/login');
    expect(await epochFor(app.withCookie('marmeon_session', out.cookie('marmeon_session')!))).not.toBe(signedIn);

    // A German guest has another epoch than an English one.
    expect(await epochFor(app.withHeaders(german))).not.toBe(guest);
  });

  it('/_marmeon/session: no-store, read-only — a guest gets no session, a signed-in one is not written, a waiting message stays', async () => {
    const guest = await app.get(SESSION_PATH).assertOk();
    expect(guest.headers.get('cache-control')).toBe('no-store');
    expect(guest.headers.getSetCookie()).toEqual([]);
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const browser = await signIn();
    await browser.put(`/users/${ada.public_id}`, { json: { name: 'Ada King', bio: '' } }).assertRedirect();
    const asked = await browser.get(SESSION_PATH).assertOk();
    expect(asked.headers.getSetCookie()).toEqual([]);
    // The message the save flashed still waits for the page the user is shown.
    await browser.navigating().get(`/users/${ada.public_id}`).assertFlash('toast', { message: 'Profile saved.' });
  });
});

describe('/_marmeon/session is read-only', () => {
  it('a remember-me cookie alone signs nobody in there (it would rotate the token and start a session) — the next page does', async () => {
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const login = await app.post('/login', { form: { email: ada.email, password: 'password', remember: 'on' }, headers: referer('/login') }).assertRedirect();
    const remembered = app.withCookie('remember_web', login.cookie('remember_web')!);
    const asked = await remembered.get(SESSION_PATH).assertOk();
    expect(asked.headers.getSetCookie()).toEqual([]);
    expect(asked.json()).toEqual({ epoch: await epochFor(app) }); // a guest's, until a page signs in
    await remembered.get('/users/me').assertRedirect(`/users/${ada.public_id}`).assertAuthenticated(ada);
  });
});

describe('flash messages stay with the document that flashed them', () => {
  it('another tab’s poll does not take a message this tab’s save flashed — this tab’s next answer does', async () => {
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const browser = await signIn();
    await browser.put(`/users/${ada.public_id}`, { json: { name: 'Ada King', bio: '' }, headers: { [DOCUMENT_HEADER]: 'tab-a' } }).assertRedirect();
    // Tab B polls the people list (a partial reload, its own document).
    await browser.navigating().get('/people', { headers: { [DOCUMENT_HEADER]: 'tab-b' } }).assertOk().assertNoFlash();
    // Tab A follows its redirect.
    await browser.navigating().get(`/users/${ada.public_id}`, { headers: { [DOCUMENT_HEADER]: 'tab-a' } }).assertFlash('toast', { message: 'Profile saved.' });
  });

  it('a full page load (no document named — the one after a 409) takes it', async () => {
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const browser = await signIn();
    await browser.put(`/users/${ada.public_id}`, { json: { name: 'Ada King', bio: '' }, headers: { [DOCUMENT_HEADER]: 'tab-a' } }).assertRedirect();
    await browser.get(`/users/${ada.public_id}`, { headers: { accept: 'text/html' } }).assertOk().assertFlash('toast');
  });
});

// ---- two tabs of one browser ----

/** One `BroadcastChannel` world: what a tab posts, the others hear a task later — never the sender, never a frozen tab. */
class Channels {
  readonly posted: unknown[] = [];
  readonly #open = new Set<{ target: EventTarget; tab: Tab }>();
  for(tab: Tab): new (name: string) => BroadcastChannel {
    const open = this.#open;
    const posted = this.posted;
    return class extends EventTarget {
      readonly #self = { target: this as EventTarget, tab };
      constructor() {
        super();
        open.add(this.#self);
      }
      postMessage(data: unknown) {
        posted.push(structuredClone(data));
        const from = this.#self;
        setTimeout(() => {
          for (const other of open) if (other !== from && !other.tab.frozen) other.target.dispatchEvent(new MessageEvent('message', { data: structuredClone(data) }));
        }, 0);
      }
      close() {
        open.delete(this.#self);
      }
    } as never;
  }
}

/** A browser: its cookies and channels, shared by its tabs. */
class Browser {
  readonly cookies = new Map<string, string>();
  readonly channels = new Channels();
  readonly kernel: Kernel;
  constructor(kernel: Kernel) {
    this.kernel = kernel;
  }

  tab(): Tab {
    return new Tab(this);
  }

  /** `fetch` with this browser's cookies, following redirects (303 → GET). */
  async request(url: string, init: RequestInit): Promise<Response> {
    let target = new URL(url, ORIGIN);
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    for (let hop = 0; hop < 10; hop++) {
      const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await this.kernel.request(target.pathname + target.search, { method, headers: { ...headers, ...(cookie ? { cookie } : {}) }, body });
      for (const line of response.headers.getSetCookie()) {
        const [pair, ...attributes] = line.split(';');
        const [name, value] = [pair!.slice(0, pair!.indexOf('=')), pair!.slice(pair!.indexOf('=') + 1)];
        if (attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || value === '') this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        if (response.status === 303 || method === 'POST') {
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

/** A tab: one document at a time (a full load replaces it), its navigator with tab sync, visible or hidden. */
class Tab {
  readonly #browser: Browser;
  readonly entries: { url: string; state: string }[] = [];
  index = -1;
  visible: PageObject | undefined;
  navigator: Navigator | undefined;
  hidden = false;
  /** Frozen (Page Lifecycle): it hears nothing on the channels. */
  frozen = false;
  /** What the server was asked: `GET /x` (a document), `GET /x (visit)`. */
  readonly requests: string[] = [];
  readonly toasts: string[] = [];
  #listeners = new Map<string, Set<(event: Event) => void>>();
  #visibility = new Set<() => void>();
  #pending: Promise<unknown>[] = [];

  constructor(browser: Browser) {
    this.#browser = browser;
  }

  async open(path: string): Promise<void> {
    await this.#load(path, 'push');
    await this.idle();
  }

  async visit(url: string, options?: Parameters<Navigator['visit']>[1]): Promise<void> {
    await this.navigator!.visit(url, options);
    await this.idle();
  }

  async back(): Promise<void> {
    this.index--;
    // Entries of a document that is gone (reloaded since) load fully — only this document's own come back by popstate.
    await this.#load(this.entries[this.index]!.url, 'traverse');
    await this.idle();
  }

  hide(): void {
    this.hidden = true;
    for (const listener of this.#visibility) listener();
  }

  show(): void {
    this.hidden = false;
    for (const listener of this.#visibility) listener();
  }

  async idle(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const pending = this.#pending;
      this.#pending = [];
      if (pending.length === 0 && round > 3) return;
      await Promise.all(pending);
    }
  }

  async #load(path: string, mode: 'push' | 'reload' | 'traverse'): Promise<void> {
    const url = new URL(path, this.entries[this.index]?.url ?? ORIGIN).href;
    this.requests.push(`GET ${new URL(url).pathname}`);
    const response = await this.#browser.request(url, { method: 'GET', headers: { accept: 'text/html' } });
    const html = await response.text();
    const match = new RegExp(`<script type="application/json" id="${PAGE_SCRIPT_ID}">(.*?)</script>`, 's').exec(html);
    const page = JSON.parse(match![1]!) as PageObject;
    if (mode === 'push') {
      this.entries.splice(this.index + 1);
      this.entries.push({ url: response.url, state: 'null' });
      this.index++;
    } else this.entries[this.index] = { url: response.url, state: response.url === this.entries[this.index]!.url ? this.entries[this.index]!.state : 'null' };
    this.#boot(page);
  }

  #boot(page: PageObject): void {
    this.#listeners = new Map();
    this.#visibility = new Set();
    this.visible = page;
    const navigator = new Navigator({
      initialPage: page,
      features: [HISTORY, tabSync],
      window: this.#window(),
      render: async (next) => void (this.visible = next),
    });
    navigator.on('flash', (message) => this.toasts.push((message.data as { message?: string }).message ?? ''));
    this.navigator = navigator;
    navigator.start();
  }

  #window(): NavigatorWindow {
    // oxlint-disable-next-line typescript/no-this-alias -- the history object's getters below have their own `this`
    const tab = this;
    const entry = () => tab.entries[tab.index]!;
    const visibility = this.#visibility;
    const listeners = this.#listeners;
    const full = (to: string | URL, mode: 'push' | 'reload') => void tab.#pending.push(tab.#load(String(to), mode));
    return {
      history: {
        get state() {
          return JSON.parse(entry().state);
        },
        pushState(state: unknown, _title: string, url?: string | URL | null) {
          tab.entries.splice(tab.index + 1);
          tab.entries.push({ url: new URL(url ?? entry().url, entry().url).href, state: JSON.stringify(state) });
          tab.index++;
        },
        replaceState(state: unknown, _title: string, url?: string | URL | null) {
          tab.entries[tab.index] = { url: new URL(url ?? entry().url, entry().url).href, state: JSON.stringify(state) };
        },
      } as NavigatorWindow['history'],
      get location() {
        const url = new URL(entry().url);
        return { href: url.href, origin: url.origin, pathname: url.pathname, search: url.search, assign: (to: string | URL) => full(to, 'push'), replace: (to: string | URL) => full(to, 'reload'), reload: () => full(entry().url, 'reload') } as NavigatorWindow['location'];
      },
      document: {
        querySelectorAll: () => [],
        getElementById: () => null,
        get visibilityState() {
          return tab.hidden ? 'hidden' : 'visible';
        },
        addEventListener: (type: string, listener: () => void) => void (type === 'visibilitychange' && visibility.add(listener)),
      },
      BroadcastChannel: this.#browser.channels.for(this),
      scrollX: 0,
      scrollY: 0,
      scrollTo: () => {},
      fetch: (input, init) => {
        const url = new URL(input, entry().url);
        this.requests.push(`${init?.method ?? 'GET'} ${url.pathname}${(init?.headers as Record<string, string> | undefined)?.[PAGE_HEADER] ? ' (visit)' : ''}`);
        const request = this.#browser.request(url.href, init ?? {});
        this.#pending.push(request);
        return request;
      },
      addEventListener: (type, listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type, listener) => void listeners.get(type)?.delete(listener),
    };
  }
}

describe('two tabs of one browser', () => {
  async function signedInTwice() {
    const ada = await app.factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com' });
    const browser = new Browser(createHttpKernel(app.application));
    const a = browser.tab();
    await a.open('/login');
    await a.visit('/login', { method: 'post', data: { email: 'ada@example.com', password: 'password' } });
    await a.open('/dashboard');
    const b = browser.tab();
    await b.open('/dashboard');
    await b.visit(`/users/${ada.public_id}`);
    expect(JSON.stringify(b.visible)).toContain('ada@example.com');
    return { ada, browser, a, b };
  }

  it('signing out in A: B (in the background) lets go of Ada and shows the login page; Back in B asks the server', async () => {
    const { browser, a, b } = await signedInTwice();
    b.hide();
    await a.visit('/logout', { method: 'post' });
    await a.idle();
    await b.idle();
    expect(a.visible!.component).toBe('auth/Login');
    expect(b.visible!.component).toBe('auth/Login');
    expect(b.navigator!.cachedPages).toBe(1);
    expect(b.requests).toEqual(expect.arrayContaining([`GET ${SESSION_PATH}`]));
    // The signed-out toast is A's (its full load took it), never B's.
    expect([a.toasts, b.toasts]).toEqual([['You have been signed out.'], []]);
    // Back in B: the entry of the dashboard loads from the server — the login page.
    await b.back();
    expect(b.visible!.component).toBe('auth/Login');
    expect(JSON.stringify(b.visible)).not.toContain('ada@example.com');
    // The tabs said epochs to each other, nothing else.
    expect(browser.channels.posted.every((message) => JSON.stringify(Object.keys(message as object)) === '["v","epoch"]')).toBe(true);
    // Ada's data as it would appear — not "ada" alone, which a random 22-character epoch contains now and then.
    expect(JSON.stringify(browser.channels.posted)).not.toMatch(/ada@example\.com|Ada Lovelace|marmeon_session|XSRF/);
  });

  it('switching the language in A: B loads again, in the new language', async () => {
    const { a, b } = await signedInTwice();
    expect(b.visible!.locale).toBe('en');
    await a.visit('/locale', { method: 'post', data: { locale: 'de' } });
    await a.idle();
    await b.idle();
    expect(a.visible!.locale).toBe('de');
    expect(b.visible!.locale).toBe('de');
    expect(b.toasts).toEqual([]);
  });

  it('a hidden tab that missed the message (frozen) catches up when it becomes visible', async () => {
    const { a, b } = await signedInTwice();
    b.hide();
    b.frozen = true;
    await a.visit('/logout', { method: 'post' });
    await a.idle();
    await b.idle();
    expect(b.visible!.component).toBe('user-profile/Show'); // still Ada's page — B missed it
    b.frozen = false;
    b.show();
    await b.idle();
    expect(b.visible!.component).toBe('auth/Login');
    expect(JSON.stringify(b.visible)).not.toContain('ada@example.com');
  });
});

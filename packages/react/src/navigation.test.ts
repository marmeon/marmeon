import { LOCATION_HEADER, PAGE_HEADER, type PageObject } from '@bespokecore/http/page';
import { describe, expect, it } from 'vitest';
import { isHistoryState, Navigator, type NavigatorWindow } from './navigation.ts';

const ORIGIN = 'https://app.test';

const page = (url: string, props: Record<string, unknown> = {}, component = 'pages/Show'): PageObject => ({ component, props, url, version: null });

const pageResponse = (body: PageObject) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: 'true', 'content-type': 'application/json' } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/**
 * One tab's history, as the browser keeps it: states are stored *serialized* (structured clone, written to
 * disk for session restore) — the test reads exactly what would end up there.
 */
class FakeWindow implements NavigatorWindow {
  readonly entries: { url: string; state: string }[] = [];
  index = -1;
  readonly requests: { url: string; method: string; headers: Record<string, string> }[] = [];
  readonly loads: string[] = [];
  scrollX = 0;
  scrollY = 0;
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();
  handler: Handler = () => new Response('not found', { status: 404 });

  constructor(url: string) {
    this.entries.push({ url, state: 'null' });
    this.index = 0;
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

  #resolve(url: string | URL | null | undefined): string {
    return url === null || url === undefined ? this.current.url : new URL(url, this.current.url).href;
  }
}

function boot(win: FakeWindow, initial: PageObject, options: { cacheSize?: number } = {}) {
  const shown: PageObject[] = [];
  const navigator = new Navigator({
    initialPage: initial,
    window: win,
    render: async (next) => void shown.push(next),
    ...options,
  });
  const stop = navigator.start();
  return { navigator, shown, stop, visible: () => shown.at(-1) ?? initial };
}

/** Lets the async work of a popstate (a refetch, a render) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Navigator — the history without props (E36)', () => {
  it('keeps only { component, url, scroll, key } in history.state — never the props', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(page('/settings/tokens', { plainText: 'bc_1|secret-token', email: 'ada@example.com' }, 'auth/AccessTokens'));
    const { navigator } = boot(win, page('/users/1', { email: 'ada@example.com' }));
    await navigator.visit('/settings/tokens');

    expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/users/1`, `${ORIGIN}/settings/tokens`]);
    for (const { state } of win.entries) {
      expect(state).not.toContain('secret-token');
      expect(state).not.toContain('ada@example.com');
      expect(Object.keys(JSON.parse(state)).sort()).toEqual(['component', 'key', 'scroll', 'url']);
      expect(isHistoryState(JSON.parse(state))).toBe(true);
    }
    expect(JSON.parse(win.current.state)).toMatchObject({ component: 'auth/AccessTokens', url: '/settings/tokens', scroll: { x: 0, y: 0 } });
  });

  it('goes back from memory, without a request', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = () => pageResponse(page('/b', { name: 'b' }));
    const { navigator, visible } = boot(win, page('/a', { name: 'a' }));
    await navigator.visit('/b');
    const before = win.requests.length;

    win.back();
    await settle();
    expect(visible().props).toEqual({ name: 'a' });
    expect(win.requests.length).toBe(before);
  });

  it('remembers where the page being left was scrolled to', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = () => pageResponse(page('/b'));
    const { navigator } = boot(win, page('/a'));
    win.scrollTo(0, 640);
    await navigator.visit('/b');
    expect(JSON.parse(win.entries[0]!.state).scroll).toEqual({ x: 0, y: 640 });
    expect(win.scrollY).toBe(0);
  });

  it('counter-check: after a reload or a session restore, Back asks the server — and shows what it answers now', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(page('/settings/tokens', { plainText: 'bc_1|secret-token' }));
    const first = boot(win, page('/users/1', { email: 'ada@example.com' }));
    await first.navigator.visit('/settings/tokens');
    first.stop();

    // The tab is restored (or reloaded) on /settings/tokens: a new document, the history entries survive — the memory does not.
    win.handler = (url) => {
      // Signed out meanwhile: the server sends the login page for /users/1.
      expect(url).toBe(`${ORIGIN}/users/1`);
      return pageResponse(page('/login', { status: null }, 'auth/Login'));
    };
    const restored = boot(win, page('/settings/tokens', { plainText: null }));
    const requests = win.requests.length;
    win.back();
    await settle();

    expect(win.requests.slice(requests)).toEqual([expect.objectContaining({ url: `${ORIGIN}/users/1`, method: 'GET', headers: expect.objectContaining({ [PAGE_HEADER]: 'true' }) })]);
    expect(restored.visible()).toMatchObject({ component: 'auth/Login', url: '/login' });
    expect(win.current.url).toBe(`${ORIGIN}/login`); // the entry is the login page now
    expect(JSON.parse(win.current.state).key).toBe(JSON.parse(win.entries[0]!.state).key);
  });

  it('never shows the props an older client left in history.state — it asks the server', async () => {
    const win = new FakeWindow(`${ORIGIN}/settings/tokens`);
    // Written by the client before E36: the whole page, plain-text token included.
    win.history.pushState(page('/settings/tokens', { plainText: 'bc_1|secret-token' }), '', '/settings/tokens');
    win.history.pushState(null, '', '/login');
    win.handler = () => pageResponse(page('/login', {}, 'auth/Login'));
    const { visible, shown } = boot(win, page('/login', {}, 'auth/Login'));

    win.back();
    await settle();
    expect(win.requests.map((request) => request.url)).toEqual([`${ORIGIN}/settings/tokens`]);
    expect(shown.map((p) => p.props)).not.toContainEqual({ plainText: 'bc_1|secret-token' });
    expect(visible().component).toBe('auth/Login');
  });

  it('keeps a bounded number of pages: the least recently shown is fetched again', async () => {
    const win = new FakeWindow(`${ORIGIN}/0`);
    win.handler = (url) => pageResponse(page(new URL(url).pathname));
    const { navigator, visible } = boot(win, page('/0'), { cacheSize: 2 });
    await navigator.visit('/1');
    await navigator.visit('/2');
    expect(navigator.cachedPages).toBe(2);

    const requests = win.requests.length;
    win.back(); // /1 — still in memory
    await settle();
    expect(win.requests.length).toBe(requests);
    win.back(); // /0 — evicted
    await settle();
    expect(win.requests.slice(requests).map((request) => request.url)).toEqual([`${ORIGIN}/0`]);
    expect(visible().url).toBe('/0');
  });

  it('loads fully on 409 + x-bespoke-location and forgets every page kept in memory', async () => {
    const win = new FakeWindow(`${ORIGIN}/settings/tokens`);
    const { navigator } = boot(win, page('/settings/tokens', { plainText: 'bc_1|secret-token' }));
    win.handler = () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login' } });
    expect(await navigator.visit('/logout', { method: 'post' })).toBeUndefined();
    expect(win.loads).toEqual(['assign /login']);
    expect(navigator.cachedPages).toBe(0);

    // The browser brings this document back from the back/forward cache: it reloads instead of showing it.
    win.dispatch('pageshow', { persisted: true });
    expect(win.loads).toEqual(['assign /login', 'reload']);
  });

  it('does not reload a document restored from the back/forward cache that was not left for a full load', () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    boot(win, page('/a'));
    win.dispatch('pageshow', { persisted: true });
    expect(win.loads).toEqual([]);
  });

  it('hands visits to other sites to the browser — their answers are never read', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    const { navigator } = boot(win, page('/a'));
    expect(await navigator.visit('https://evil.test/x')).toBeUndefined();
    expect(win.requests).toEqual([]);
    expect(win.loads).toEqual(['assign https://evil.test/x']);
  });

  it('ignores the popstate of a fragment entry (#section) on the same page', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    const { shown } = boot(win, page('/a'));
    win.entries.push({ url: `${ORIGIN}/a#links`, state: 'null' });
    win.index = 1;
    win.dispatch('popstate', { state: null });
    await settle();
    expect(shown).toEqual([]);
    expect(win.requests).toEqual([]);
  });
});

import { LOCATION_HEADER, PAGE_HEADER, type PageObject } from '@bespokecore/http/page';
import { describe, expect, it } from 'vitest';
import { isHistoryState, mergePage, Navigator, type NavigatorWindow, type ScrollRegion, type VisitException } from './navigation.ts';

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
  scrollRestoration: ScrollRestoration = 'auto';
  /** The page's `[scroll-region]` elements. */
  regions: ScrollRegion[] = [];
  readonly document = {
    querySelectorAll: (selector: string) => (selector === '[scroll-region]' ? this.regions : []),
    getElementById: () => null,
  };
  XMLHttpRequest?: new () => XMLHttpRequest;
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

/** Records a navigator's events, in order. */
function record(navigator: Navigator) {
  const events: string[] = [];
  const errors: VisitException[] = [];
  navigator.on('start', (visit) => events.push(`start ${visit.method} ${visit.url}`));
  navigator.on('progress', (progress) => events.push(`progress ${progress.percentage}`));
  navigator.on('success', (_page, visit) => events.push(`success ${visit.url}`));
  navigator.on('error', (invalid) => events.push(`error ${Object.keys(invalid).join(',')}`));
  navigator.on('cancel', (visit) => events.push(`cancel ${visit.url}`));
  navigator.on('exception', (exception) => (events.push(`exception ${exception.type}`), errors.push(exception)));
  navigator.on('finish', (visit) => events.push(`finish ${visit.url}`));
  return { events, errors };
}

describe('Navigator — visit events and failures', () => {
  it('reports start and finish of a visit — per visit too', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = () => pageResponse(page('/b'));
    const { navigator } = boot(win, page('/a'));
    const { events } = record(navigator);
    const own: string[] = [];
    await navigator.visit('/b', {
      onStart: () => own.push('start'),
      onSuccess: () => own.push('success'),
      onError: () => own.push('error'),
      onException: () => own.push('exception'),
      onFinish: () => own.push('finish'),
    });
    expect(events).toEqual(['start get /b', 'success /b', 'finish /b']);
    expect(own).toEqual(['start', 'success', 'finish']);
  });

  it('reports validation errors as `error` (Inertia’s meaning) — the page with them is shown', async () => {
    const win = new FakeWindow(`${ORIGIN}/edit`);
    // A failed form: the server redirects back, the page carries the errors.
    win.handler = () => pageResponse(page('/edit', { errors: { name: ['The name is required.'] } }));
    const { navigator, visible } = boot(win, page('/edit', { errors: {} }));
    const { events } = record(navigator);
    const own: unknown[] = [];
    const shown = await navigator.visit('/edit', { method: 'put', data: { name: '' }, onError: (errors) => void own.push(errors), onSuccess: () => void own.push('success') });
    expect(events).toEqual(['start put /edit', 'error name', 'finish /edit']);
    expect(own).toEqual([{ name: ['The name is required.'] }]);
    expect(shown).toBe(visible());
  });

  it('turns a network failure into an exception event — not a rejection — and leaves page and history as they are', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = () => {
      throw new TypeError('Failed to fetch');
    };
    const { navigator, shown } = boot(win, page('/a'));
    const { events, errors } = record(navigator);
    const own: VisitException[] = [];
    const invalid: unknown[] = [];

    await expect(navigator.visit('/b', { onException: (exception) => void own.push(exception), onError: (errors) => void invalid.push(errors) })).resolves.toBeUndefined();
    expect(invalid).toEqual([]);
    expect(events).toEqual(['start get /b', 'exception network', 'finish /b']);
    expect(errors[0]).toMatchObject({ type: 'network', visit: { url: '/b', method: 'get' }, cause: expect.any(TypeError) });
    expect(own).toEqual(errors);
    expect(shown).toEqual([]);
    expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/a`]);
    expect(win.loads).toEqual([]);
  });

  it('reports a 5xx with the server’s error page — the page on screen stays, no history entry', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    const errorPage = page('/b', { status: 500, title: 'Server Error', message: 'boom', exception: { name: 'Error', message: 'boom', stack: '…' } }, 'errors/Error');
    win.handler = () => new Response(JSON.stringify(errorPage), { status: 500, headers: { [PAGE_HEADER]: 'true' } });
    const { navigator, shown } = boot(win, page('/a'));
    const { events, errors } = record(navigator);

    expect(await navigator.visit('/b', { method: 'post', data: { name: 'Ada' } })).toBeUndefined();
    expect(events).toEqual(['start post /b', 'exception server', 'finish /b']);
    expect(errors[0]).toMatchObject({ type: 'server', status: 500, page: errorPage, html: undefined });
    expect(shown).toEqual([]);
    expect(win.entries).toHaveLength(1);
  });

  it('hands plain HTML of a 5xx (a proxy, say) to the exception event instead of loading it', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = () => new Response('<h1>502 Bad Gateway</h1>', { status: 502, headers: { 'content-type': 'text/html' } });
    const { navigator } = boot(win, page('/a'));
    const { errors } = record(navigator);
    await navigator.visit('/b');
    expect(errors[0]).toMatchObject({ type: 'server', status: 502, page: undefined, html: '<h1>502 Bad Gateway</h1>' });
    expect(win.loads).toEqual([]);
  });

  it('shows 4xx pages as pages (404, 403) — they are answers, not failures', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = () => new Response(JSON.stringify(page('/missing', { status: 404 }, 'errors/Error')), { status: 404, headers: { [PAGE_HEADER]: 'true' } });
    const { navigator, visible } = boot(win, page('/a'));
    const { errors } = record(navigator);
    await navigator.visit('/missing');
    expect(errors).toEqual([]);
    expect(visible().component).toBe('errors/Error');
  });

  it('cancels the older of two visits — the newer one wins', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = (url, init) =>
      url.endsWith('/slow')
        ? new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
        : pageResponse(page('/fast'));
    const { navigator, visible } = boot(win, page('/a'));
    const { events } = record(navigator);
    const own: string[] = [];
    const slow = navigator.visit('/slow', { onCancel: () => own.push('cancelled') });
    await navigator.visit('/fast');
    expect(await slow).toBeUndefined();
    expect(events).toEqual(['start get /slow', 'start get /fast', 'cancel /slow', 'finish /slow', 'success /fast', 'finish /fast']);
    expect(own).toEqual(['cancelled']);
    expect(visible().url).toBe('/fast');
  });

  it('reports the upload progress of FormData — over XHR, the page headers included', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    const sent: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
    win.XMLHttpRequest = class FakeXhr extends EventTarget {
      readonly upload = new EventTarget();
      status = 0;
      statusText = '';
      responseText = '';
      responseURL = '';
      #request = { method: '', url: '', headers: {} as Record<string, string> };
      open(method: string, url: string) {
        this.#request = { method, url, headers: {} };
      }
      setRequestHeader(name: string, value: string) {
        this.#request.headers[name] = value;
      }
      getAllResponseHeaders() {
        return `content-type: application/json\r\n${PAGE_HEADER}: true\r\n`;
      }
      abort() {}
      send(body: unknown) {
        sent.push({ ...this.#request, body });
        for (const loaded of [250, 1000]) this.upload.dispatchEvent(Object.assign(new Event('progress'), { loaded, total: 1000, lengthComputable: true }));
        Object.assign(this, { status: 200, responseText: JSON.stringify(page('/a', { uploaded: true })), responseURL: `${ORIGIN}/a` });
        this.dispatchEvent(new Event('load'));
      }
    } as never;
    const { navigator, visible } = boot(win, page('/a'));
    const { events } = record(navigator);
    const own: number[] = [];
    const data = new FormData();
    data.append('avatar', new Blob(['…'], { type: 'image/png' }), 'avatar.png');

    await navigator.visit('/a', { method: 'post', data, onProgress: (progress) => void own.push(progress.percentage!) });
    expect(events).toEqual(['start post /a', 'progress 25', 'progress 100', 'success /a', 'finish /a']);
    expect(own).toEqual([25, 100]);
    expect(sent[0]).toMatchObject({ method: 'POST', url: '/a', headers: { [PAGE_HEADER]: 'true' }, body: data });
    expect(visible().props).toEqual({ uploaded: true });
  });

  it('sends data with a file in it as multipart, nested keys in brackets', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    let body: unknown;
    win.handler = (_url, init) => ((body = init.body), pageResponse(page('/a')));
    const { navigator } = boot(win, page('/a'));
    const avatar = new File(['…'], 'avatar.png', { type: 'image/png' });
    await navigator.visit('/a', { method: 'post', data: { name: 'Ada', public: true, avatar, links: [{ url: 'https://ada.dev' }], note: null } });
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect([...form.keys()]).toEqual(['name', 'public', 'avatar', 'links[0][url]', 'note']);
    expect(form.get('public')).toBe('1');
    expect(form.get('avatar')).toBeInstanceOf(File);
    expect(form.get('note')).toBe('');
  });

  it('reload() fetches the current page again in place, keeping the scroll position', async () => {
    const win = new FakeWindow(`${ORIGIN}/a?tab=links`);
    win.handler = () => pageResponse(page('/a?tab=links', { fresh: true }));
    const { navigator, visible } = boot(win, page('/a?tab=links', { fresh: false }));
    win.scroll(400);
    await navigator.reload();
    expect(win.requests.at(-1)).toMatchObject({ url: `${ORIGIN}/a?tab=links`, method: 'GET' });
    expect(visible().props).toEqual({ fresh: true });
    expect(win.entries).toHaveLength(1);
    expect(win.scrollY).toBe(400);
  });
});

describe('Navigator — scroll restoration', () => {
  /** Lets the debounced write of the scroll position into the history entry happen. */
  const debounce = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('takes over scroll restoration from the browser', () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    boot(win, page('/a'));
    expect(win.scrollRestoration).toBe('manual');
  });

  it('restores the window and every scroll-region on Back and Forward — new pages start at the top', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.regions = [
      { scrollLeft: 0, scrollTop: 0 },
      { scrollLeft: 0, scrollTop: 0 },
    ];
    win.handler = (url) => pageResponse(page(new URL(url).pathname));
    const { navigator } = boot(win, page('/a'));

    win.scroll(500, 120, 30);
    await navigator.visit('/b');
    expect([win.scrollY, ...win.regions.map((region) => region.scrollTop)]).toEqual([0, 0, 0]);
    win.scroll(300, 40, 0);

    win.back();
    await settle();
    expect([win.scrollY, ...win.regions.map((region) => region.scrollTop)]).toEqual([500, 120, 30]);
    win.forward();
    await settle();
    expect([win.scrollY, ...win.regions.map((region) => region.scrollTop)]).toEqual([300, 40, 0]);
  });

  it('a position still waiting to be saved never lands in the entry Back went to', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = () => pageResponse(page('/b'));
    const { navigator } = boot(win, page('/a'));
    win.scroll(500);
    await navigator.visit('/b');
    win.scroll(300); // and Back right away, before the debounced save
    win.back();
    await settle();
    await debounce();
    expect(JSON.parse(win.entries[0]!.state).scroll).toEqual({ x: 0, y: 500 });
    expect(win.scrollY).toBe(500);
  });

  it('writes the position into the entry, so a reload or a session restore comes back to it', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.regions = [{ scrollLeft: 0, scrollTop: 0 }];
    const first = boot(win, page('/a'));
    win.scroll(700, 90);
    await debounce();
    expect(JSON.parse(win.current.state)).toMatchObject({ scroll: { x: 0, y: 700 }, regions: [{ x: 0, y: 90 }] });
    first.stop();

    // Reload: a new document in the same entry, scrolled to the top by the browser (restoration is manual).
    win.scrollTo(0, 0);
    win.regions[0]!.scrollTop = 0;
    boot(win, page('/a'));
    expect(win.scrollY).toBe(700);
    expect(win.regions[0]!.scrollTop).toBe(90);
  });

  it('keeps the position with preserveScroll', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = () => pageResponse(page('/a', { saved: true }));
    const { navigator } = boot(win, page('/a'));
    win.scroll(250);
    await navigator.visit('/a', { method: 'put', data: {}, preserveScroll: true });
    expect(win.scrollY).toBe(250);
  });

  it('scrolls only after the page is on screen — render resolves first', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = () => pageResponse(page('/b'));
    const order: string[] = [];
    const navigator = new Navigator({
      initialPage: page('/a'),
      window: Object.assign(win, { scrollTo: (x: number, y: number) => (order.push(`scroll ${y}`), FakeWindow.prototype.scrollTo.call(win, x, y)) }),
      render: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('rendered');
      },
    });
    navigator.start();
    win.scroll(500);
    await navigator.visit('/b');
    win.back();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['rendered', 'scroll 0', 'rendered', 'scroll 500']);
  });
});

describe('Navigator — partial reloads and deferred props (E7)', () => {
  /** A response the test lets through when it wants to — a slow server. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { open, opened };
  }

  it('reload({ only }) asks for some props of the page on screen and merges them into it — in memory too, never in the history', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(page('/users/1', { stats: { links: 3 } }));
    const { navigator, visible } = boot(win, page('/users/1', { name: 'Ada', errors: {} }));
    await navigator.reload({ only: ['stats'] });

    expect(win.requests.at(-1)!.headers).toMatchObject({
      'x-bespoke': 'true',
      'x-bespoke-partial-component': 'pages/Show',
      'x-bespoke-partial-data': 'stats',
    });
    expect(visible().props).toEqual({ name: 'Ada', errors: {}, stats: { links: 3 } });
    expect(win.entries).toHaveLength(1); // a reload replaces
    expect(win.current.state).not.toContain('links');

    // The merged page is the entry's page in memory: away and Back shows it without a request.
    win.handler = () => pageResponse(page('/other'));
    await navigator.visit('/other');
    const requests = win.requests.length;
    win.back();
    await settle();
    expect(visible().props).toEqual({ name: 'Ada', errors: {}, stats: { links: 3 } });
    expect(win.requests.length).toBe(requests);
  });

  it('sends except, and merges nothing when another page comes back (a redirect to the login)', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(page('/login', { status: null }, 'auth/Login'));
    const { navigator, visible } = boot(win, page('/users/1', { name: 'Ada' }));
    await navigator.reload({ except: ['others'] });
    expect(win.requests.at(-1)!.headers).toMatchObject({ 'x-bespoke-partial-component': 'pages/Show', 'x-bespoke-partial-except': 'others' });
    expect(win.requests.at(-1)!.headers).not.toHaveProperty('x-bespoke-partial-data');
    expect(visible()).toMatchObject({ component: 'auth/Login', props: { status: null } });
  });

  it('appends merge props, merges deepMerge props all the way down — unless reset', async () => {
    const win = new FakeWindow(`${ORIGIN}/people`);
    const initial = { ...page('/people', { links: [1, 2], feed: { data: [1], meta: { page: 1 } }, total: 4 }), mergeProps: ['links'], deepMergeProps: ['feed'] };
    win.handler = () => pageResponse({ ...page('/people?page=2', { links: [3, 4], feed: { data: [2], meta: { page: 2 } } }), mergeProps: ['links'], deepMergeProps: ['feed'] });
    const { navigator, visible } = boot(win, initial);
    await navigator.visit('/people?page=2', { only: ['links', 'feed'], preserveState: true, preserveScroll: true, replace: true });
    expect(visible().props).toEqual({ links: [1, 2, 3, 4], feed: { data: [1, 2], meta: { page: 2 } }, total: 4 });
    expect(visible().url).toBe('/people?page=2');

    await navigator.visit('/people?page=2', { only: ['links'], reset: ['links'], replace: true });
    expect(visible().props.links).toEqual([3, 4]);
  });

  it('a deferred prop does not hold up the first render: the page is shown without it, the group is loaded after', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const slow = gate();
    win.handler = async () => {
      await slow.opened; // the server takes its time
      return pageResponse(page('/users/1', { activity: ['signed in'], errors: { stale: ['from the request before'] } }));
    };
    const events: string[] = [];
    const shown: PageObject[] = [];
    const navigator = new Navigator({
      initialPage: { ...page('/users/1', { name: 'Ada', errors: {} }), deferredProps: { default: ['activity'] } },
      window: win,
      render: async (next) => void shown.push(next),
    });
    navigator.on('start', (visit) => events.push(`start${visit.async ? ' async' : ''}`));
    navigator.on('success', () => events.push('success'));
    navigator.on('finish', (visit) => events.push(`finish${visit.async ? ' async' : ''}`));
    navigator.start();

    // The server-rendered page is on screen, without `activity`; the request for it is out.
    expect(shown).toEqual([]);
    expect(navigator.page.props).not.toHaveProperty('activity');
    expect(win.requests).toHaveLength(1);
    expect(win.requests[0]!.headers).toMatchObject({ 'x-bespoke-partial-component': 'pages/Show', 'x-bespoke-partial-data': 'activity' });

    slow.open();
    await settle();
    // Only the group's props landed — the `always` errors of that request did not overwrite the page's.
    expect(shown.at(-1)!.props).toEqual({ name: 'Ada', errors: {}, activity: ['signed in'] });
    expect(shown.at(-1)!.deferredProps).toBeUndefined();
    expect(events).toEqual(['start async', 'finish async']); // a background request: no success of a visit
  });

  it('loads groups in parallel, and lands a group in the page it was for — also after leaving it', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const slow = gate();
    win.handler = async (url, init) => {
      const asked = (init.headers as Record<string, string>)['x-bespoke-partial-data'];
      if (asked === 'audit') await slow.opened;
      if (asked === undefined) return pageResponse(page('/other', { other: true }, 'pages/Other'));
      return pageResponse(page('/users/1', asked === 'audit' ? { audit: ['log'] } : { activity: ['a'], teams: ['t'] }));
    };
    const { navigator, visible } = boot(win, { ...page('/users/1', { name: 'Ada' }), deferredProps: { default: ['activity', 'teams'], slow: ['audit'] } });
    expect(win.requests.map((request) => request.headers['x-bespoke-partial-data'])).toEqual(['activity,teams', 'audit']);
    await settle();
    expect(visible().props).toEqual({ name: 'Ada', activity: ['a'], teams: ['t'] });
    expect(visible().deferredProps).toEqual({ slow: ['audit'] });

    // Away before the slow group is there: the visit is not held up, and the group lands in the page left.
    await navigator.visit('/other');
    expect(visible().props).toEqual({ other: true });
    slow.open();
    await settle();
    expect(visible().props).toEqual({ other: true });
    const requests = win.requests.length;
    win.back();
    await settle();
    expect(visible().props).toEqual({ name: 'Ada', activity: ['a'], teams: ['t'], audit: ['log'] });
    expect(win.requests.length).toBe(requests); // complete in memory — nothing to load again
  });

  it('drops deferred props for a URL the entry no longer shows (a replacing visit to another user)', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const slow = gate();
    win.handler = async (url, init) => {
      if ((init.headers as Record<string, string>)['x-bespoke-partial-data'] === 'activity') {
        await slow.opened;
        return pageResponse(page('/users/1', { activity: ['of user 1'] }));
      }
      return pageResponse(page('/users/2', { name: 'Grace' }));
    };
    const { navigator, visible } = boot(win, { ...page('/users/1', { name: 'Ada' }), deferredProps: { default: ['activity'] } });
    await navigator.visit('/users/2', { replace: true });
    slow.open();
    await settle();
    expect(visible().props).toEqual({ name: 'Grace' });
  });

  it('lands nothing in a document left for a full page load (signed out while a group was loading) — and aborts it', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const slow = gate();
    let signal: AbortSignal | undefined;
    win.handler = async (url, init) => {
      if ((init.headers as Record<string, string>)['x-bespoke-partial-data'] === 'activity') {
        signal = init.signal ?? undefined;
        await slow.opened;
        return pageResponse(page('/users/1', { activity: ['of ada'] }));
      }
      return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: `${ORIGIN}/login` } });
    };
    const { navigator, shown } = boot(win, { ...page('/users/1', { name: 'Ada' }), deferredProps: { default: ['activity'] } });
    await navigator.visit('/logout', { method: 'post' });
    expect(win.loads).toEqual([`assign ${ORIGIN}/login`]);
    expect(signal?.aborted).toBe(true);
    slow.open();
    await settle();
    expect(shown).toEqual([]);
  });

  it('loads the deferred props of a page a visit arrives at — and of one Back brings from the server', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = (url, init) =>
      (init.headers as Record<string, string>)['x-bespoke-partial-data'] === 'activity'
        ? pageResponse(page('/users/1', { activity: ['x'] }))
        : pageResponse({ ...page('/users/1', { name: 'Ada' }), deferredProps: { default: ['activity'] } });
    const { navigator, visible } = boot(win, page('/a'));
    await navigator.visit('/users/1');
    await settle();
    expect(visible().props).toEqual({ name: 'Ada', activity: ['x'] });
    expect(win.requests.map((request) => request.headers['x-bespoke-partial-data'])).toEqual([undefined, 'activity']);
  });
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const purpose = (request: { headers: Record<string, string> }) => request.headers.purpose;

describe('Navigator — prefetching', () => {
  it('fetches a page ahead (GET, Purpose: prefetch) — the visit shows it without asking again', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (url) => pageResponse(page(new URL(url).pathname, { name: 'Grace' }));
    const { navigator, visible } = boot(win, page('/users/1', { name: 'Ada' }));
    await navigator.prefetch('/users/2');
    expect(win.requests).toEqual([{ url: `${ORIGIN}/users/2`, method: 'GET', headers: expect.objectContaining({ [PAGE_HEADER]: 'true', purpose: 'prefetch' }) }]);
    expect(visible().props).toEqual({ name: 'Ada' }); // fetched, not shown

    const events: string[] = [];
    await navigator.visit('/users/2', { onSuccess: () => events.push('success'), onFinish: () => events.push('finish') });
    expect(visible().props).toEqual({ name: 'Grace' });
    expect(win.requests).toHaveLength(1);
    expect(events).toEqual(['success', 'finish']);
    // History as for any visit: an entry, no props in it.
    expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/users/1`, `${ORIGIN}/users/2`]);
    expect(win.current.state).not.toContain('Grace');
  });

  it('a visit while the prefetch is still under way waits for it — one request, not two', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const slow = gate();
    win.handler = async () => {
      await slow.opened;
      return pageResponse(page('/users/2', { name: 'Grace' }));
    };
    const { navigator, visible } = boot(win, page('/users/1'));
    void navigator.prefetch('/users/2');
    void navigator.prefetch('/users/2'); // hovered again: still the one request
    const visiting = navigator.visit('/users/2');
    slow.open();
    await visiting;
    expect(visible().props).toEqual({ name: 'Grace' });
    expect(win.requests).toHaveLength(1);
  });

  it('counter-check: never prefetches anything but a GET — nor another site', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(page('/x'));
    const { navigator } = boot(win, page('/users/1'));
    for (const method of ['post', 'put', 'patch', 'delete', 'POST']) await navigator.prefetch('/logout', { method } as never);
    await navigator.prefetch('https://elsewhere.test/page');
    await navigator.prefetch('/users/1'); // the page on screen
    expect(win.requests).toEqual([]);
  });

  it('uses a prefetched page once, within cacheFor — then the server is asked again', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    let n = 0;
    win.handler = (url) => pageResponse(page(new URL(url).pathname, { n: ++n }));
    const { navigator, visible } = boot(win, page('/a'));
    await navigator.prefetch('/b');
    await navigator.visit('/b');
    await navigator.visit('/a');
    await navigator.visit('/b');
    expect(visible().props).toEqual({ n: 3 }); // not the prefetched n: 1 again

    await navigator.prefetch('/c', { cacheFor: 0 }); // stale as soon as it arrives
    await navigator.visit('/c');
    expect(visible().props).toEqual({ n: 5 });
    expect(win.requests.map(purpose)).toEqual(['prefetch', undefined, undefined, 'prefetch', undefined]);
  });

  it.each([
    ['signing out (POST → 409)', 'post'],
    ['a GET visit answered with 409 (a new build — or the session ended in another tab, the next visit hits the login)', 'get'],
  ] as const)('counter-check: after a hard page change — %s — a prefetched protected page is never shown', async (_, method) => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    let signedIn = true;
    win.handler = (url) => {
      if (url.endsWith('/logout')) {
        signedIn = false;
        return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login' } });
      }
      return signedIn ? pageResponse(page('/settings/security', { email: 'ada@example.com' }, 'auth/Security')) : pageResponse(page('/login', {}, 'auth/Login'));
    };
    const { navigator, visible } = boot(win, page('/users/1', { name: 'Ada' }));
    await navigator.prefetch('/settings/security');
    expect(navigator.prefetchedPages).toBe(1);
    await navigator.visit('/logout', { method });
    expect(win.loads).toEqual(['assign /login']);
    expect(navigator.prefetchedPages).toBe(0);

    // Should this document live on (the browser brings it back, a click before it unloads): the server is asked.
    await navigator.visit('/settings/security');
    expect(JSON.stringify(visible())).not.toContain('ada@example.com');
    expect(visible().component).toBe('auth/Login');
    expect(win.requests.at(-1)).toMatchObject({ url: `${ORIGIN}/settings/security`, method: 'GET' });
    expect(purpose(win.requests.at(-1)!)).toBeUndefined();
  });

  it('a prefetch still under way when the document is left lands nowhere — and is aborted', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const slow = gate();
    let signal: AbortSignal | undefined;
    win.handler = async (url, init) => {
      if (init.method === 'POST') return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login' } });
      signal = init.signal ?? undefined;
      await slow.opened;
      return pageResponse(page('/settings/security', { email: 'ada@example.com' }));
    };
    const { navigator } = boot(win, page('/users/1'));
    const prefetching = navigator.prefetch('/settings/security');
    await navigator.visit('/logout', { method: 'post' });
    expect(signal?.aborted).toBe(true);
    slow.open();
    await prefetching;
    expect(navigator.prefetchedPages).toBe(0);
  });

  it('forgets what is no page to show as it is — 409 after a deployment, a download, offline, 5xx — without navigating or events', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    const answers: (() => Response)[] = [
      () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/b' } }),
      () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } }), // not a page: a download
      () => {
        throw new TypeError('Failed to fetch');
      },
    ];
    for (const answer of answers) {
      win.handler = answer;
      const { navigator, stop } = boot(win, page('/a'));
      const exceptions: unknown[] = [];
      navigator.on('exception', (exception) => exceptions.push(exception));
      navigator.on('start', (visit) => exceptions.push(visit));
      await navigator.prefetch('/b');
      expect(win.loads).toEqual([]);
      expect(exceptions).toEqual([]); // no events, no fallback for a prefetch
      expect(navigator.prefetchedPages).toBe(0);
      stop();
    }
    // A 5xx error page with the page header is not kept either.
    win.handler = () => new Response(JSON.stringify(page('/b', {}, 'errors/Error')), { status: 500, headers: { [PAGE_HEADER]: 'true' } });
    const { navigator } = boot(win, page('/a'));
    await navigator.prefetch('/b');
    expect(navigator.prefetchedPages).toBe(0);
  });

  it('a form (non-GET visit) drops every prefetched page — what they show may have changed', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = (url, init) => pageResponse(page(init.method === 'POST' ? '/a' : new URL(url).pathname));
    const { navigator } = boot(win, page('/a'));
    await navigator.prefetch('/b');
    await navigator.prefetch('/c');
    expect(navigator.prefetchedPages).toBe(2);
    await navigator.visit('/a', { method: 'post', data: { name: 'x' } });
    expect(navigator.prefetchedPages).toBe(0);
  });

  it('takes data into the query string — and never a prefetch for a partial reload or a visit with its own headers', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = (url) => pageResponse(page(new URL(url).pathname + new URL(url).search));
    const { navigator } = boot(win, page('/a'));
    await navigator.prefetch('/b', { data: { tab: 'links' } });
    expect(win.requests[0]!.url).toBe(`${ORIGIN}/b?tab=links`);
    await navigator.visit('/b?tab=links', { headers: { 'x-custom': '1' } });
    expect(win.requests).toHaveLength(2);
  });
});

describe('Navigator — background visits, "load more", merging without duplicates', () => {
  it('an async visit neither cancels the visit under way nor is cancelled by it — and lands only on the page it started from', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    const slow = gate();
    const cancelled: string[] = [];
    win.handler = async (url, init) => {
      if ((init.headers as Record<string, string>)['x-bespoke-partial-data'] === 'count') {
        await slow.opened;
        return pageResponse(page('/a', { count: 2 }));
      }
      return pageResponse(page('/b', { name: 'b' }));
    };
    const { navigator, visible } = boot(win, page('/a', { count: 1 }));
    navigator.on('cancel', (visit) => cancelled.push(visit.url));
    const poll = navigator.reload({ only: ['count'], async: true });
    await navigator.visit('/b'); // the user moves on meanwhile
    slow.open();
    expect(await poll).toBeUndefined();
    expect(visible().props).toEqual({ name: 'b' }); // not yanked back to /a
    expect(cancelled).toEqual([]);
  });

  it('an async reload of the page on screen merges in place, without a progress-bar visit', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    win.handler = () => pageResponse(page('/a', { count: 2 }));
    const { navigator, visible } = boot(win, page('/a', { count: 1, name: 'a' }));
    const visits: unknown[] = [];
    navigator.on('start', (visit) => visits.push(visit));
    await navigator.reload({ only: ['count'], async: true });
    expect(visible().props).toEqual({ count: 2, name: 'a' });
    expect(visits).toEqual([{ url: '/a', method: 'get', async: true }]);
  });

  it('"load more": reload({ data, only, preserveUrl }) appends the next page — the URL stays, Back/Forward keep what was loaded, a reload starts over', async () => {
    const win = new FakeWindow(`${ORIGIN}/people`);
    const people = (cursor: string | null) => (cursor === null ? [{ id: 1 }, { id: 2 }] : cursor === 'c2' ? [{ id: 3 }, { id: 4 }] : [{ id: 5 }]);
    const next = (cursor: string | null) => (cursor === null ? 'c2' : cursor === 'c2' ? 'c3' : null);
    win.handler = (url) => {
      const { pathname, search, searchParams } = new URL(url);
      if (pathname === '/other') return pageResponse(page('/other', {}, 'pages/Other'));
      const cursor = searchParams.get('cursor');
      return pageResponse({
        ...page(pathname + search, { list: { data: people(cursor), meta: { nextCursor: next(cursor) } } }),
        deepMergeProps: ['list'],
        matchPropsOn: ['list.data.id'],
      });
    };
    const first = (cursor: string | null) => ({ ...page('/people', { list: { data: people(cursor), meta: { nextCursor: next(cursor) } } }) });
    const { navigator, visible, stop } = boot(win, first(null));
    await navigator.reload({ data: { cursor: 'c2' }, only: ['list'], preserveUrl: true });
    expect(win.requests[0]!.url).toBe(`${ORIGIN}/people?cursor=c2`);
    expect(visible().props).toEqual({ list: { data: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], meta: { nextCursor: 'c3' } } });
    expect(visible().url).toBe('/people');
    expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/people`]);
    // As a link (`<Link href="?cursor=c3" only preserveUrl>`): a visit, not a reload — still no new entry.
    await navigator.visit('/people?cursor=c3', { only: ['list'], preserveUrl: true, preserveScroll: true });
    expect((visible().props.list as { data: unknown[] }).data).toHaveLength(5);
    expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/people`]);

    await navigator.visit('/other');
    const requests = win.requests.length;
    win.back();
    await settle();
    expect((visible().props.list as { data: unknown[] }).data).toHaveLength(5); // from memory, as it was left
    expect(win.requests.length).toBe(requests);

    // A reload of the tab: a new document on /people — the server sends the first page, nothing appended.
    stop();
    const reloaded = boot(win, first(null));
    expect((reloaded.visible().props.list as { data: unknown[] }).data).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('counter-check: the same page fetched twice is merged without duplicates (matchPropsOn) — items with a known key take the old one’s place', () => {
    const current = page('/people', { list: { data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], meta: { next: 'c2' } }, flat: [{ id: 1 }] });
    const again: PageObject = {
      ...page('/people', { list: { data: [{ id: 2, name: 'b2' }, { id: 3, name: 'c' }], meta: { next: 'c3' } }, flat: [{ id: 1 }, { id: 9 }] }),
      deepMergeProps: ['list'],
      mergeProps: ['flat'],
      matchPropsOn: ['list.data.id', 'flat.id'],
    };
    const once = mergePage(current, again);
    const twice = mergePage(once, again);
    for (const merged of [once, twice]) {
      expect(merged.props.list).toEqual({ data: [{ id: 1, name: 'a' }, { id: 2, name: 'b2' }, { id: 3, name: 'c' }], meta: { next: 'c3' } });
      expect(merged.props.flat).toEqual([{ id: 1 }, { id: 9 }]);
    }
    expect(twice.matchPropsOn).toEqual(['list.data.id', 'flat.id']);
    // Without a key to match on, the same page twice is appended twice (what matchOn is for).
    const { matchPropsOn: _, ...unmatched } = again;
    expect((mergePage(mergePage(current, unmatched), unmatched).props.list as { data: unknown[] }).data).toHaveLength(6);
  });
});

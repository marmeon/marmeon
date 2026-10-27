import { LOCATION_HEADER, PAGE_HEADER, RELOAD_HEADER, type PageObject, PROTOCOL_VERSION } from '../protocol.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isHistoryState, mergePage, Navigator, type VisitError } from './navigation.ts';
import type { PatchTarget } from './optimistic.ts';
import { boot, FakeEntry, FakeWindow, historyFeatures, ORIGIN, page, pageResponse, PATHS, settle } from './test-window.ts';
import type { RegionOwner } from './owner.ts';
import { pageInfo } from '../page-support.ts';
import { prefetch } from './features/prefetch.ts';
import { prefetchWith } from './lazy.ts';

describe.each(PATHS)('the navigator on the %s path', (path) => {
  beforeEach(() => void (FakeWindow.path = path));
  afterEach(() => void (FakeWindow.path = 'navigation'));

  describe('Navigator — the history without props', () => {
    it('keeps only { component, url, scroll, key } in the entry’s state (+ its `index` in the History fallback) — never the props', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      win.handler = () => pageResponse(page('/settings/tokens', { plainText: 'marmeon_1|secret-token', email: 'ada@example.com' }, 'auth/AccessTokens'));
      const { navigator } = boot(win, page('/users/1', { email: 'ada@example.com' }));
      await navigator.visit('/settings/tokens');

      expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/users/1`, `${ORIGIN}/settings/tokens`]);
      for (const { state, disk } of win.entries) {
        expect(disk, 'props in a history entry').not.toContain('secret-token');
        expect(disk, 'props in a history entry').not.toContain('ada@example.com');
        // `index`: the entry's position the History fallback counts (for the navigation guard) — a number, like the scroll.
        expect(Object.keys(JSON.parse(state)).sort()).toEqual(path === 'history' ? ['component', 'index', 'key', 'scroll', 'url'] : ['component', 'key', 'scroll', 'url']);
        expect(isHistoryState(JSON.parse(state))).toBe(true);
      }
      // With the Navigation API, `history.state` stays null: the entry's state is the Navigation API's.
      if (path !== 'history') for (const entry of win.entries) expect(entry.history).toBe('null');
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

    it('after a reload or a session restore, Back asks the server — and shows what it answers now', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      win.handler = () => pageResponse(page('/settings/tokens', { plainText: 'marmeon_1|secret-token' }));
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

      expect(win.requests.slice(requests)).toEqual([expect.objectContaining({ url: `${ORIGIN}/users/1`, method: 'GET', headers: expect.objectContaining({ [PAGE_HEADER]: PROTOCOL_VERSION }) })]);
      expect(restored.visible()).toMatchObject({ component: 'auth/Login', url: '/login' });
      expect(win.current.url).toBe(`${ORIGIN}/login`); // the entry is the login page now
      expect(JSON.parse(win.current.state).key).toBe(JSON.parse(win.entries[0]!.state).key);
    });

    it('never shows the props a script left in history.state', async () => {
      const win = new FakeWindow(`${ORIGIN}/settings/tokens`);
      // Written by a script: the whole page, plain-text token included.
      win.history.pushState(page('/settings/tokens', { plainText: 'marmeon_1|secret-token' }), '', '/settings/tokens');
      win.history.pushState(null, '', '/login');
      win.handler = () => pageResponse(page('/login', {}, 'auth/Login'));
      const { visible, shown } = boot(win, page('/login', {}, 'auth/Login'));

      win.back();
      await settle();
      // An entry without the navigator's state is the browser's (or another script's): the navigator leaves it alone.
      expect(win.requests).toEqual([]);
      expect(shown.map((p) => p.props)).not.toContainEqual({ plainText: 'marmeon_1|secret-token' });
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

    it('loads fully on 409 + x-marmeon-location and forgets every page kept in memory', async () => {
      const win = new FakeWindow(`${ORIGIN}/settings/tokens`);
      const { navigator } = boot(win, page('/settings/tokens', { plainText: 'marmeon_1|secret-token' }));
      win.handler = () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login' } });
      expect(await navigator.visit('/logout', { method: 'post' })).toBeUndefined();
      expect(win.loads).toEqual(['assign https://app.test/login']);
      expect(navigator.cachedPages).toBe(0);

      // The browser brings this document back from the back/forward cache: it reloads instead of showing it.
      win.dispatch('pageshow', { persisted: true });
      expect(win.loads).toEqual(['assign https://app.test/login', 'reload']);
    });

    it('a 409 for another version of the protocol loads fully exactly once — whatever the page still sends afterwards (no reload loop)', async () => {
      const win = new FakeWindow(`${ORIGIN}/a`);
      const { navigator } = boot(win, page('/a'));
      win.handler = () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: `${ORIGIN}/b`, [RELOAD_HEADER]: 'version' } });
      expect(await navigator.visit('/b')).toBeUndefined();
      expect(await navigator.visit('/c')).toBeUndefined();
      await navigator.reload();
      expect(win.loads).toEqual(['assign https://app.test/b']);
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

    it('ignores Back/Forward to a fragment’s entry (#section) on the same page', async () => {
      const win = new FakeWindow(`${ORIGIN}/a`);
      const { shown } = boot(win, page('/a'));
      win.entries.push(new FakeEntry(`${ORIGIN}/a#links`));
      win.forward();
      await settle();
      win.back();
      await settle();
      expect(shown).toEqual([]);
      expect(win.requests).toEqual([]);
    });
  });

  /** The server failure of an exception, for asserting on its `page`. */
  function failure(exception: VisitError | undefined) {
    return exception?.type === 'server' ? exception : undefined;
  }

  /** Records a navigator's events, in order. */
  function record(navigator: Navigator) {
    const events: string[] = [];
    const errors: VisitError[] = [];
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
    /**
     * A navigator whose render of a page waits for its own `release()` — the page's view code still loading: the pages under
     * `/slow`, and those added to `hold`.
     */
    function slowBoot(win: FakeWindow, initial: PageObject, options: Pick<ConstructorParameters<typeof Navigator>[0], 'loadLayers'> = {}) {
      const held = new Map<string, () => void>();
      const hold = new Set<string>();
      const shown: string[] = [];
      const owners = new Map<string, RegionOwner>();
      const navigator = new Navigator({
        initialPage: initial,
        window: win,
        features: historyFeatures(win),
        ...options,
        render: async (next, { signal, owner }) => {
          if (next.url.startsWith('/slow') || hold.has(next.url)) {
            owners.set(next.url, owner);
            await new Promise<void>((release) => held.set(next.url, release));
          }
          if (signal?.aborted) return;
          shown.push(next.url);
        },
      });
      navigator.start();
      return { navigator, held, hold, shown, owners };
    }

    it('lets a newer visit win when an older one’s view is still loading', async () => {
      const win = new FakeWindow(`${ORIGIN}/start`);
      win.handler = (url) => pageResponse(page(new URL(url).pathname));
      const { navigator, held, shown, owners } = slowBoot(win, page('/start'));
      const { events } = record(navigator);
      const length = win.entries.length;

      const older = navigator.visit('/slow-a');
      await settle();
      expect(held.has('/slow-a')).toBe(true);
      await navigator.visit('/b');
      expect(shown.at(-1)).toBe('/b');

      held.get('/slow-a')!();
      expect(await older).toBeUndefined();
      await settle();

      expect(shown).toEqual(['/b']);
      expect(win.current.url).toBe(`${ORIGIN}/b`);
      expect(win.entries.length).toBe(length + 1);
      expect(win.entries.map((entry) => entry.url)).not.toContain(`${ORIGIN}/slow-a`);
      expect(events).not.toContain('success /slow-a');
      expect(events).toContain('cancel /slow-a');
      expect(events).toContain('finish /slow-a');
      expect(events).toContain('success /b');
      expect(owners.get('/slow-a')!.closed).toBe(true);
    });

    it('lets Back win when the view of a visit is still loading', async () => {
      const win = new FakeWindow(`${ORIGIN}/start`);
      win.handler = (url) => pageResponse(page(new URL(url).pathname));
      const { navigator, held, shown } = slowBoot(win, page('/start'));
      await navigator.visit('/b');
      const length = win.entries.length;

      const older = navigator.visit('/slow-a');
      await settle();
      expect(held.has('/slow-a')).toBe(true);
      win.back();
      await settle();
      held.get('/slow-a')!();
      expect(await older).toBeUndefined();
      await settle();

      expect(shown.at(-1)).toBe('/start');
      expect(win.current.url).toBe(`${ORIGIN}/start`);
      expect(win.entries.length).toBe(length);
      expect(win.entries.map((entry) => entry.url)).not.toContain(`${ORIGIN}/slow-a`);
    });

    it('lets the later Back/Forward win when an earlier one’s view is still loading — and scrolls only for the later', async () => {
      const win = new FakeWindow(`${ORIGIN}/start`);
      win.handler = (url) => pageResponse(page(new URL(url).pathname));
      const { navigator, held, hold, shown } = slowBoot(win, page('/start'));
      await navigator.visit('/b');
      win.scroll(300);
      await navigator.visit('/c');
      hold.add('/b');

      win.back(); // /b — its view is held
      await settle();
      expect(held.has('/b')).toBe(true);
      win.back(); // /start
      await settle();
      expect(shown.at(-1)).toBe('/start');
      expect(win.scrollY).toBe(0);

      held.get('/b')!();
      await settle();
      expect(shown.at(-1)).toBe('/start');
      expect(win.scrollY).toBe(0); // the position of /b is not applied to /start
      expect(win.current.url).toBe(`${ORIGIN}/start`);
    });

    it('lets a visit in the background lose to a foreground visit that landed while its view loaded', async () => {
      const win = new FakeWindow(`${ORIGIN}/start`);
      win.handler = (url) => pageResponse(page(new URL(url).pathname));
      const { navigator, held, shown } = slowBoot(win, page('/start'));
      const length = win.entries.length;

      const background = navigator.visit('/slow-a', { async: true });
      await settle();
      expect(held.has('/slow-a')).toBe(true);
      await navigator.visit('/b');

      held.get('/slow-a')!();
      expect(await background).toBeUndefined();
      await settle();
      expect(shown).toEqual(['/b']);
      expect(win.current.url).toBe(`${ORIGIN}/b`);
      expect(win.entries.length).toBe(length + 1);
    });

    it('keeps the messages of a page still loading until that page is on screen — a dropped render fires none', async () => {
      const win = new FakeWindow(`${ORIGIN}/start`);
      const message = { id: 'm1', key: 'toast', data: { message: 'Saved.' } };
      win.handler = (url) => {
        const path = new URL(url).pathname;
        return pageResponse(path === '/slow-c' ? { ...page(path), flash: [message] as never } : page(path));
      };
      const { navigator, held } = slowBoot(win, page('/start'));
      const fired: string[] = [];
      navigator.on('flash', (flash) => fired.push(flash.id));

      const older = navigator.visit('/slow-a');
      await settle();
      const newer = navigator.visit('/slow-c');
      await settle();
      held.get('/slow-a')!();
      expect(await older).toBeUndefined();
      await settle();
      expect(fired).toEqual([]);

      held.get('/slow-c')!();
      await newer;
      expect(fired).toEqual(['m1']);
    });

    it('keeps the messages of a page still loading when a request in the background ends meanwhile', async () => {
      const win = new FakeWindow(`${ORIGIN}/start`);
      const message = { id: 'm1', key: 'toast', data: { message: 'Saved.' } };
      win.handler = (url) => {
        const path = new URL(url).pathname;
        return pageResponse(path === '/slow-c' ? { ...page(path), flash: [message] as never } : page(path));
      };
      const { navigator, held } = slowBoot(win, page('/start'));
      const fired: string[] = [];
      navigator.on('flash', (flash) => fired.push(flash.id));

      const newer = navigator.visit('/slow-c');
      await settle();
      expect(held.has('/slow-c')).toBe(true);
      await navigator.visit('/d', { async: true });
      expect(fired).toEqual([]);

      held.get('/slow-c')!();
      await newer;
      expect(fired).toEqual(['m1']);
    });

    it('keeps a background visit from landing while the newest draw is still held — a stale draw ending does not end it', async () => {
      const win = new FakeWindow(`${ORIGIN}/start`);
      win.handler = (url) => pageResponse(page(new URL(url).pathname));
      const { navigator, held, shown } = slowBoot(win, page('/start'));

      const stale = navigator.visit('/slow-a');
      await settle();
      const newest = navigator.visit('/slow-b');
      await settle();
      held.get('/slow-a')!();
      expect(await stale).toBeUndefined();

      expect(await navigator.visit('/start', { async: true })).toBeUndefined();
      expect(shown).toEqual([]);

      held.get('/slow-b')!();
      expect((await newest)?.url).toBe('/slow-b');
    });

    it('does not cancel a visit when a layer closes (Escape) while its view is loading — the page lands', async () => {
      const win = new FakeWindow(`${ORIGIN}/start`);
      win.handler = (url) => {
        const path = new URL(url).pathname;
        return pageResponse(path === '/edit' ? { ...page(path), layer: { key: path, base: '/start' } } : page(path));
      };
      const { navigator, held, shown } = slowBoot(win, page('/start'));
      const { events } = record(navigator);
      await navigator.visit('/edit', { layer: true });
      expect(navigator.layers).toHaveLength(1);

      const visit = navigator.visit('/slow-a');
      await settle();
      expect(held.has('/slow-a')).toBe(true);
      await navigator.layers[0]!.close();
      await settle();

      held.get('/slow-a')!();
      const landed = await visit;
      await settle();
      expect(landed?.url).toBe('/slow-a');
      expect(shown.at(-1)).toBe('/slow-a');
      expect(win.current.url).toBe(`${ORIGIN}/slow-a`);
      expect(events).toContain('success /slow-a');
    });

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

    it('reports validation errors as `error` — the page with them is shown', async () => {
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
      const own: VisitError[] = [];
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
      win.handler = () => new Response(JSON.stringify(errorPage), { status: 500, headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
      const { navigator, shown } = boot(win, page('/a'));
      const { events, errors } = record(navigator);

      expect(await navigator.visit('/b', { method: 'post', data: { name: 'Ada' } })).toBeUndefined();
      expect(events).toEqual(['start post /b', 'exception server', 'finish /b']);
      expect(errors[0]).toMatchObject({ type: 'server', status: 500, page: pageInfo(errorPage), html: undefined });
      // @ts-expect-error `version` is a wire field: apps use `useNewVersion()` / `on('version')`
      void failure(errors[0])!.page!.version;
      expect(Object.keys(failure(errors[0])!.page!).sort()).toEqual(['component', 'props', 'url']);
      expect(shown).toEqual([]);
      expect(win.entries).toHaveLength(1);
    });

    it('gives callbacks and listeners the page as PageInfo — no wire fields', async () => {
      const win = new FakeWindow(`${ORIGIN}/a`);
      win.handler = () => pageResponse(page('/b'));
      const { navigator } = boot(win, page('/a'));
      const seen: object[] = [];
      navigator.on('success', (next) => {
        // @ts-expect-error `version` is a wire field: apps use `useNewVersion()` / `on('version')`
        void next.version;
        // @ts-expect-error `deferredProps` is a wire field: apps use `<Deferred>` / `<WhenVisible>`
        void next.deferredProps;
        seen.push(next);
      });
      await navigator.visit('/b', {
        onSuccess: (next) => {
          // @ts-expect-error `layers` is a wire field: apps use `useLayer()`
          void next.layers;
          seen.push(next);
        },
      });
      expect(seen).toHaveLength(2);
      for (const next of seen) expect(Object.keys(next)).not.toContain('version');
      expect(seen[0]).toEqual(pageInfo(page('/b')));
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
      win.handler = () => new Response(JSON.stringify(page('/missing', { status: 404 }, 'errors/Error')), { status: 404, headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
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
          return `content-type: application/json\r\n${PAGE_HEADER}: ${PROTOCOL_VERSION}\r\n`;
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
      expect(sent[0]).toMatchObject({ method: 'POST', url: `${ORIGIN}/a`, headers: { [PAGE_HEADER]: PROTOCOL_VERSION }, body: data });
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
      // `scrollRegions` — not `regions`, the name islands' regions (which never go into the entry) would collide with.
      expect(JSON.parse(win.current.state)).toMatchObject({ scroll: { x: 0, y: 700 }, scrollRegions: [{ x: 0, y: 90 }] });
      expect(JSON.parse(win.current.state)).not.toHaveProperty('regions');
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
        features: historyFeatures(win),
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

  describe('Navigator — deferred groups streamed with the document', () => {
    const streamed = (): PageObject => ({ ...page('/users/1', { name: 'Ada' }), deferredProps: { default: ['activity'], slow: ['audit'] }, streamedProps: ['default'] });

    it('does not ask for a group the server streams — it lands what the adapter hands over, once the document has arrived', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      win.readyState = 'loading';
      win.handler = () => pageResponse(page('/users/1', { audit: ['log'] }));
      const { navigator, visible } = boot(win, streamed());
      await settle(); // the loading code is a chunk of its own
      // Only the group that is not streamed is asked for.
      expect(win.requests.map((request) => request.headers['x-marmeon-partial-data'])).toEqual(['audit']);
      const landing = navigator.receiveStreamed('default', { props: { activity: ['signed in'] } });
      await settle();
      // Still streaming: an update now would make the adapter render a part that is still on its way in the browser.
      expect(visible().props).not.toHaveProperty('activity');
      win.finishLoading();
      await landing;
      expect(visible().props).toMatchObject({ name: 'Ada', activity: ['signed in'], audit: ['log'] });
      expect(visible().deferredProps).toBeUndefined();
      expect(win.requests).toHaveLength(1);
    });

    it('takes only the props of the group from a streamed block — never its component, URL or other props', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      win.handler = () => pageResponse(page('/users/1', { audit: ['log'] }));
      const { navigator, visible } = boot(win, streamed());
      await navigator.receiveStreamed('default', {
        component: 'Admin',
        url: '/admin',
        props: { activity: ['signed in'], name: 'Mallory', audit: ['forged'] },
      } as never);
      await settle();
      expect(visible().component).toBe(page('/users/1', {}).component);
      expect(visible().url).toBe('/users/1');
      expect(visible().props).toMatchObject({ name: 'Ada', activity: ['signed in'], audit: ['log'] });
    });

    it('without streamedProps every group is asked for', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      win.handler = () => pageResponse(page('/users/1', {}));
      const { streamedProps: _streamed, ...withoutStreaming } = streamed();
      boot(win, withoutStreaming);
      await settle();
      expect(win.requests.map((request) => request.headers['x-marmeon-partial-data']).sort()).toEqual(['activity', 'audit']);
    });

    it('asks for a streamed group that did not come (null) — and takes nothing for a group it never waited for', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      win.handler = () => pageResponse(page('/users/1', { activity: ['fetched'], audit: ['log'] }));
      const { navigator, visible } = boot(win, streamed());
      await navigator.receiveStreamed('default', null);
      await settle();
      expect(win.requests.map((request) => request.headers['x-marmeon-partial-data']).sort()).toEqual(['activity', 'audit']);
      expect(visible().props).toMatchObject({ activity: ['fetched'] });
      await navigator.receiveStreamed('slow', { props: { audit: ['forged'] } });
      expect(visible().props).toMatchObject({ audit: ['log'] });
    });
  });

  describe('Navigator — partial reloads and deferred props', () => {
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
        [PAGE_HEADER]: PROTOCOL_VERSION,
        'x-marmeon-partial-component': 'pages/Show',
        'x-marmeon-partial-data': 'stats',
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
      expect(win.requests.at(-1)!.headers).toMatchObject({ 'x-marmeon-partial-component': 'pages/Show', 'x-marmeon-partial-except': 'others' });
      expect(win.requests.at(-1)!.headers).not.toHaveProperty('x-marmeon-partial-data');
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
        features: historyFeatures(win),
        initialPage: { ...page('/users/1', { name: 'Ada', errors: {} }), deferredProps: { default: ['activity'] } },
        window: win,
        render: async (next) => void shown.push(next),
      });
      navigator.on('start', (visit) => events.push(`start${visit.async ? ' async' : ''}`));
      navigator.on('success', () => events.push('success'));
      navigator.on('finish', (visit) => events.push(`finish${visit.async ? ' async' : ''}`));
      navigator.start();
      await settle(); // the loading code is a chunk of its own

      // The server-rendered page is on screen, without `activity`; the request for it is out.
      expect(shown).toEqual([]);
      expect(navigator.page.props).not.toHaveProperty('activity');
      expect(win.requests).toHaveLength(1);
      expect(win.requests[0]!.headers).toMatchObject({ 'x-marmeon-partial-component': 'pages/Show', 'x-marmeon-partial-data': 'activity' });

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
        const asked = (init.headers as Record<string, string>)['x-marmeon-partial-data'];
        if (asked === 'audit') await slow.opened;
        if (asked === undefined) return pageResponse(page('/other', { other: true }, 'pages/Other'));
        return pageResponse(page('/users/1', asked === 'audit' ? { audit: ['log'] } : { activity: ['a'], teams: ['t'] }));
      };
      const { navigator, visible } = boot(win, { ...page('/users/1', { name: 'Ada' }), deferredProps: { default: ['activity', 'teams'], slow: ['audit'] } });
      await settle();
      expect(win.requests.map((request) => request.headers['x-marmeon-partial-data'])).toEqual(['activity,teams', 'audit']);
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
        if ((init.headers as Record<string, string>)['x-marmeon-partial-data'] === 'activity') {
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
        if ((init.headers as Record<string, string>)['x-marmeon-partial-data'] === 'activity') {
          signal = init.signal ?? undefined;
          await slow.opened;
          return pageResponse(page('/users/1', { activity: ['of ada'] }));
        }
        return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: `${ORIGIN}/login` } });
      };
      const { navigator, shown } = boot(win, { ...page('/users/1', { name: 'Ada' }), deferredProps: { default: ['activity'] } });
      await settle(); // the loading code is a chunk of its own: the group's request is out
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
        (init.headers as Record<string, string>)['x-marmeon-partial-data'] === 'activity'
          ? pageResponse(page('/users/1', { activity: ['x'] }))
          : pageResponse({ ...page('/users/1', { name: 'Ada' }), deferredProps: { default: ['activity'] } });
      const { navigator, visible } = boot(win, page('/a'));
      await navigator.visit('/users/1');
      await settle();
      expect(visible().props).toEqual({ name: 'Ada', activity: ['x'] });
      expect(win.requests.map((request) => request.headers['x-marmeon-partial-data'])).toEqual([undefined, 'activity']);
    });
  });

  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { open, opened };
  }

  const purpose = (request: { headers: Record<string, string> }) => request.headers.purpose;

  describe('Navigator — a visit’s optimistic patches', () => {
    /** A target that keeps its own patches (a layer, an island) — recording what the core does with them. */
    function target() {
      const calls: string[] = [];
      let next = 0;
      const patchTarget: PatchTarget = {
        add: () => (calls.push('add'), ++next),
        settle: (ids, commit, options) => void calls.push(`settle ${ids.join(',')} ${commit ? 'commit' : 'drop'}${options?.quiet ? ' quiet' : ''}`),
        revalidate: async () => undefined,
      };
      return { calls, patchTarget };
    }

    it('the core shows them while the visit is under way, and takes them out with its answer — no feature attached', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      const slow = gate();
      win.handler = async () => (await slow.opened, pageResponse(page('/users/1', { name: 'Grace' })));
      const { navigator } = boot(win, page('/users/1'), { features: [] });
      const { calls, patchTarget } = target();
      const visiting = navigator.visit('/users/1', { method: 'put', data: {}, optimistic: { target: patchTarget, patch: () => ({ name: 'Saving…' }) } });
      await settle();
      expect(calls).toEqual(['add']);
      slow.open();
      await visiting;
      // Taken out in the render of the answer (quiet), then nothing left to roll back.
      expect(calls).toEqual(['add', 'settle 1 drop quiet', 'settle 1 drop']);
    });

    it('a visit that fails rolls its patches back', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      win.handler = () => Promise.reject(new TypeError('offline'));
      const { navigator } = boot(win, page('/users/1'), { features: [] });
      const { calls, patchTarget } = target();
      await navigator.visit('/users/1', { method: 'put', data: {}, optimistic: [{ target: patchTarget, patch: () => ({}) }, { target: patchTarget, patch: () => ({}) }] });
      expect(calls).toEqual(['add', 'add', 'settle 1,2 drop']);
    });
  });

  describe('Navigator — prefetching', () => {
    it('fetches a page ahead (GET, Purpose: prefetch) — the visit shows it without asking again', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      win.handler = (url) => pageResponse(page(new URL(url).pathname, { name: 'Grace' }));
      const { navigator, visible } = boot(win, page('/users/1', { name: 'Ada' }));
      await navigator.use(prefetch).prefetch('/users/2');
      expect(win.requests).toEqual([{ url: `${ORIGIN}/users/2`, method: 'GET', headers: expect.objectContaining({ [PAGE_HEADER]: PROTOCOL_VERSION, purpose: 'prefetch' }) }]);
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
      void navigator.use(prefetch).prefetch('/users/2');
      void navigator.use(prefetch).prefetch('/users/2'); // hovered again: still the one request
      const visiting = navigator.visit('/users/2');
      slow.open();
      await visiting;
      expect(visible().props).toEqual({ name: 'Grace' });
      expect(win.requests).toHaveLength(1);
    });

    it('a press on a link fetched ahead asks nothing again — once loaded, the prefetch code prefetches at once', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      win.handler = (url) => pageResponse(page(new URL(url).pathname, { name: 'Grace' }));
      // The page takes a moment to render (React commits later): the visit is under way a while after it took the page.
      const rendered = gate();
      const navigator = new Navigator({ initialPage: page('/users/1'), window: win, render: () => rendered.opened, features: historyFeatures(win) });
      navigator.start();
      await prefetchWith(navigator, '/users/2'); // hovered: the code loads, the page comes
      // Pressed (the link prefetches on mousedown, for touch screens), then clicked: the press must find the page fetched ahead
      // before the click's visit takes it — else it fetches it once more, for nobody.
      const pressed = prefetchWith(navigator, '/users/2');
      const visiting = navigator.visit('/users/2');
      await pressed;
      rendered.open();
      await visiting;
      expect(navigator.page.url).toBe('/users/2');
      expect(win.requests.map(purpose)).toEqual(['prefetch']);
      expect(navigator.use(prefetch).size).toBe(0);
    });

    it('the very first press (no hover before, the prefetch code not here yet) asks once — the click’s visit, not a prefetch for nobody', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      const slow = gate();
      win.handler = async (url) => {
        await slow.opened;
        return pageResponse(page(new URL(url).pathname, { name: 'Grace' }));
      };
      const navigator = new Navigator({ initialPage: page('/users/1'), window: win, render: async () => undefined, features: historyFeatures(win) });
      navigator.start();
      // Pressed (a touch screen, or a click without a hover first): the prefetch code starts loading — then the click's visit goes.
      const pressed = prefetchWith(navigator, '/users/2');
      const visiting = navigator.visit('/users/2');
      await settle();
      slow.open();
      await Promise.all([pressed, visiting]);
      expect(navigator.page.url).toBe('/users/2');
      expect(win.requests.map(purpose)).toEqual([undefined]);
      expect(navigator.use(prefetch).size).toBe(0);
    });

    it('never prefetches anything but a GET — nor another site', async () => {
      const win = new FakeWindow(`${ORIGIN}/users/1`);
      win.handler = () => pageResponse(page('/x'));
      const { navigator } = boot(win, page('/users/1'));
      for (const method of ['post', 'put', 'patch', 'delete', 'POST']) await navigator.use(prefetch).prefetch('/logout', { method } as never);
      await navigator.use(prefetch).prefetch('https://elsewhere.test/page');
      await navigator.use(prefetch).prefetch('/users/1'); // the page on screen
      expect(win.requests).toEqual([]);
    });

    it('uses a prefetched page once, within cacheForMs — then the server is asked again', async () => {
      const win = new FakeWindow(`${ORIGIN}/a`);
      let n = 0;
      win.handler = (url) => pageResponse(page(new URL(url).pathname, { n: ++n }));
      const { navigator, visible } = boot(win, page('/a'));
      await navigator.use(prefetch).prefetch('/b');
      await navigator.visit('/b');
      await navigator.visit('/a');
      await navigator.visit('/b');
      expect(visible().props).toEqual({ n: 3 }); // not the prefetched n: 1 again

      await navigator.use(prefetch).prefetch('/c', { cacheForMs: 0 }); // stale as soon as it arrives
      await navigator.visit('/c');
      expect(visible().props).toEqual({ n: 5 });
      expect(win.requests.map(purpose)).toEqual(['prefetch', undefined, undefined, 'prefetch', undefined]);
    });

    it.each([
      ['signing out (POST → 409)', 'post'],
      ['a GET visit answered with 409 (a new build — or the session ended in another tab, the next visit hits the login)', 'get'],
    ] as const)('after a hard page change — %s — a prefetched protected page is never shown', async (_, method) => {
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
      await navigator.use(prefetch).prefetch('/settings/security');
      expect(navigator.use(prefetch).size).toBe(1);
      await navigator.visit('/logout', { method });
      expect(win.loads).toEqual(['assign https://app.test/login']);
      expect(navigator.use(prefetch).size).toBe(0);

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
      const prefetching = navigator.use(prefetch).prefetch('/settings/security');
      await navigator.visit('/logout', { method: 'post' });
      expect(signal?.aborted).toBe(true);
      slow.open();
      await prefetching;
      expect(navigator.use(prefetch).size).toBe(0);
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
        await navigator.use(prefetch).prefetch('/b');
        expect(win.loads).toEqual([]);
        expect(exceptions).toEqual([]); // no events, no fallback for a prefetch
        expect(navigator.use(prefetch).size).toBe(0);
        stop();
      }
      // A 5xx error page with the page header is not kept either.
      win.handler = () => new Response(JSON.stringify(page('/b', {}, 'errors/Error')), { status: 500, headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
      const { navigator } = boot(win, page('/a'));
      await navigator.use(prefetch).prefetch('/b');
      expect(navigator.use(prefetch).size).toBe(0);
    });

    it('a form (non-GET visit) drops every prefetched page — what they show may have changed', async () => {
      const win = new FakeWindow(`${ORIGIN}/a`);
      win.handler = (url, init) => pageResponse(page(init.method === 'POST' ? '/a' : new URL(url).pathname));
      const { navigator } = boot(win, page('/a'));
      await navigator.use(prefetch).prefetch('/b');
      await navigator.use(prefetch).prefetch('/c');
      expect(navigator.use(prefetch).size).toBe(2);
      await navigator.visit('/a', { method: 'post', data: { name: 'x' } });
      expect(navigator.use(prefetch).size).toBe(0);
    });

    it('takes data into the query string — and never a prefetch for a partial reload or a visit with its own headers', async () => {
      const win = new FakeWindow(`${ORIGIN}/a`);
      win.handler = (url) => pageResponse(page(new URL(url).pathname + new URL(url).search));
      const { navigator } = boot(win, page('/a'));
      await navigator.use(prefetch).prefetch('/b', { data: { tab: 'links' } });
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
        if ((init.headers as Record<string, string>)['x-marmeon-partial-data'] === 'count') {
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

    it('the same page fetched twice is merged without duplicates (matchPropsOn) — items with a known key take the old one’s place', () => {
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
});

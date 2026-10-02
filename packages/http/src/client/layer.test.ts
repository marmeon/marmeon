import { describe, expect, it } from 'vitest';
import { LAYER_BACKDROP, LAYER_CLOSE_HEADER, LOCATION_HEADER, MAX_LAYER_DEPTH, PAGE_HEADER, PARTIAL_DATA_HEADER, REGION_HEADER, type PageObject } from '../page.ts';
import { isHistoryState } from './navigation.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse, settle } from './test-window.ts';

/** A layer's page object, as the server answers `this.view(…).layer({ base })`. */
const layer = (url: string, props: Record<string, unknown> = {}, component = 'users/Edit', info: Partial<NonNullable<PageObject['layer']>> = {}): PageObject => ({
  ...page(url, props, component),
  layer: { key: component, base: '/users/1', ...info },
});

const closeResponse = (close: { layers: number; reload?: readonly string[] | true }) =>
  new Response(JSON.stringify({ close }), { headers: { 'content-type': 'application/json', [LAYER_CLOSE_HEADER]: 'true' } });

/** Waits for the popstate a `history.go()` fires (a task later) and what it starts. */
const tick = async () => {
  await settle();
  await settle();
};

function profile(win: FakeWindow, props: Record<string, unknown> = { name: 'Ada' }) {
  return boot(win, page('/users/1', props, 'users/Show'));
}

describe('Layers in the client core (E53) — opening over the page on screen', () => {
  it('opens a layer over the page on screen — one request (the layer’s), a history entry of its own, the page stays', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(layer('/users/1/edit', { profile: { name: 'Ada' } }));
    const app = profile(win);
    const base = app.navigator.page;
    const opened = await app.navigator.visit('/users/1/edit', { layer: true });

    expect(opened?.layer).toMatchObject({ key: 'users/Edit', base: '/users/1' });
    expect(win.requests).toEqual([expect.objectContaining({ url: `${ORIGIN}/users/1/edit`, headers: expect.objectContaining({ [REGION_HEADER]: 'layer', [PAGE_HEADER]: 'true' }) })]);
    expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/users/1`, `${ORIGIN}/users/1/edit`]);
    // The page under it is the same object: not fetched, not rendered anew.
    expect(app.navigator.page).toBe(base);
    expect(app.visible()).toBe(base);
    expect(app.layers().map((open) => [open.depth, open.page.component])).toEqual([[1, 'users/Edit']]);
  });

  it('keeps no layer props in history.state — the key, the URL, the depth and the keys beneath (E36)', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(layer('/settings/tokens', { plainText: 'bc_1|secret-token', email: 'ada@example.com' }, 'auth/NewToken', { once: true }));
    const app = profile(win, { email: 'ada@example.com' });
    await app.navigator.visit('/settings/tokens', { layer: true });

    for (const { state } of win.entries) {
      expect(state).not.toContain('secret-token');
      expect(state).not.toContain('ada@example.com');
      expect(isHistoryState(JSON.parse(state))).toBe(true);
    }
    const top = JSON.parse(win.current.state);
    expect(Object.keys(top).sort()).toEqual(['component', 'index', 'key', 'layer', 'scroll', 'url']);
    expect(top.layer).toEqual({ depth: 1, below: [JSON.parse(win.entries[0]!.state).key] });
  });

  it('a visit without `layer` whose answer is a layer opens it over the page too (client-opened layers stack, Max 02.10.)', async () => {
    const win = new FakeWindow(`${ORIGIN}/people`);
    win.handler = () => pageResponse(layer('/users/1/edit'));
    const app = boot(win, page('/people', {}, 'users/People'));
    await app.navigator.visit('/users/1/edit');
    // Over /people — not over its declared base /users/1: that is for deep links.
    expect(app.navigator.page.component).toBe('users/People');
    expect(app.layers()).toHaveLength(1);
  });

  it('a layer request answered with a page (signed out: the login) shows that page — no layer', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(page('/login', {}, 'auth/Login'));
    const app = profile(win);
    await app.navigator.visit('/users/1/edit', { layer: true });
    expect(app.visible().component).toBe('auth/Login');
    expect(app.layers()).toEqual([]);
  });
});

describe('Layers — Back, Forward, close', () => {
  it('counter-check: Back closes the layer, not the page — from memory, the page not rendered again, no deferred props asked again', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (url) => (url.endsWith('/edit') ? pageResponse(layer('/users/1/edit')) : pageResponse({ ...page('/users/1', { activity: ['signed in'] }, 'users/Show') }));
    const app = boot(win, { ...page('/users/1', { name: 'Ada' }, 'users/Show'), deferredProps: { default: ['activity'] } });
    await settle();
    const base = app.navigator.page;
    expect(base.props).toMatchObject({ activity: ['signed in'] });
    const requests = win.requests.length;
    const renders = app.shown.length;
    await app.navigator.visit('/users/1/edit', { layer: true });

    win.back();
    await tick();
    expect(app.layers()).toEqual([]);
    expect(win.current.url).toBe(`${ORIGIN}/users/1`);
    expect(app.navigator.page).toBe(base);
    // Only the layer's request; the renders handed the same page object (the adapter keeps it).
    expect(win.requests.length).toBe(requests + 1);
    expect(app.shown.slice(renders).every((shown) => shown === base)).toBe(true);
  });

  it('Forward opens the layer again from memory — no request', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(layer('/users/1/edit', { name: 'Ada' }));
    const app = profile(win);
    await app.navigator.visit('/users/1/edit', { layer: true });
    win.back();
    await tick();
    const requests = win.requests.length;

    win.forward();
    await tick();
    expect(app.layers().map((open) => open.page.props)).toEqual([{ name: 'Ada' }]);
    expect(win.requests.length).toBe(requests);
  });

  it('close() goes back to the entry beneath — and forgets the layer: Forward asks the server again', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    let version = 0;
    win.handler = () => pageResponse(layer('/users/1/edit', { version: ++version }));
    const app = profile(win);
    await app.navigator.visit('/users/1/edit', { layer: true });
    const [open] = app.layers();
    const closed: string[] = [];
    open!.onClose(() => closed.push('closed'));

    const requests = win.requests.length;
    await open!.close();
    // Closed from memory: the page beneath is not asked for again (nor its deferred props, nor its islands).
    expect(win.requests.length).toBe(requests);
    expect(closed).toEqual(['closed']);
    expect(open!.closed).toBe(true);
    expect(app.layers()).toEqual([]);
    expect(win.index).toBe(0);
    expect(win.entries).toHaveLength(2); // the layer's entry is still ahead — Forward

    win.forward();
    await tick();
    await tick();
    expect(app.layers().map((reopened) => reopened.page.props)).toEqual([{ version: 2 }]);
  });

  it('counter-check: what is on screen stays in memory, however small the cache — the layer closes by Back, the page from memory', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(layer('/users/1/edit'));
    const app = boot(win, page('/users/1', { name: 'Ada' }, 'users/Show'), { cacheSize: 1 });
    await app.navigator.visit('/users/1/edit', { layer: true });
    const requests = win.requests.length;
    await app.layers()[0]!.close();
    // Back in the history (the layer's entry was kept: it knew it was pushed over the page's) — not a replaced entry.
    expect(win.index).toBe(0);
    expect(win.entries).toHaveLength(2);
    expect(app.visible().props).toEqual({ name: 'Ada' });
    expect(win.requests.length).toBe(requests);
  });

  it('closing twice before it is gone (a second Escape) closes nothing more — not the layer beneath', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (url) => pageResponse(url.endsWith('/remove') ? layer('/users/1/links/5/remove', {}, 'users/RemoveLink') : layer('/users/1/edit'));
    const app = profile(win);
    await app.navigator.visit('/users/1/edit', { layer: true });
    await app.layers()[0]!.visit('/users/1/links/5/remove');
    const top = app.layers()[1]!;
    await Promise.all([top.close(), top.close()]);
    await tick();
    expect(app.layers().map((open) => open.depth)).toEqual([1]);
    expect(win.index).toBe(1);
  });

  it('“close, then Back” does not open it again — Back leaves the page', async () => {
    const win = new FakeWindow(`${ORIGIN}/people`);
    win.handler = (url) => (url.endsWith('/edit') ? pageResponse(layer('/users/1/edit')) : pageResponse(page('/users/1', {}, 'users/Show')));
    const app = boot(win, page('/people', {}, 'users/People'));
    await app.navigator.visit('/users/1');
    await app.navigator.visit('/users/1/edit', { layer: true });
    await app.layers()[0]!.close();

    win.back();
    await tick();
    expect(app.visible().component).toBe('users/People');
    expect(app.layers()).toEqual([]);
  });

  it('stacks to depth 2 — Back closes the top one only, the one beneath stays as it was (its state, its object)', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (url) => pageResponse(url.endsWith('/remove') ? layer('/users/1/links/5/remove', {}, 'users/RemoveLink') : layer('/users/1/edit'));
    const app = profile(win);
    await app.navigator.visit('/users/1/edit', { layer: true });
    const [edit] = app.layers();
    await edit!.visit('/users/1/links/5/remove');
    expect(app.layers().map((open) => [open.depth, open.page.component])).toEqual([
      [1, 'users/Edit'],
      [2, 'users/RemoveLink'],
    ]);
    expect(JSON.parse(win.current.state).layer.depth).toBe(2);

    win.back();
    await tick();
    expect(app.layers()).toEqual([edit]);
    expect(edit!.closed).toBe(false);
  });

  it(`counter-check: the depth limit holds — an answer that would open layer ${MAX_LAYER_DEPTH + 1} is shown as a page`, async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    let n = 0;
    win.handler = () => pageResponse(layer(`/step/${++n}`, {}, `steps/Step${n}`));
    const app = profile(win);
    await app.navigator.visit('/step', { layer: true });
    for (let depth = 2; depth <= MAX_LAYER_DEPTH; depth++) await app.layers().at(-1)!.visit('/step');
    expect(app.layers()).toHaveLength(MAX_LAYER_DEPTH);

    await app.layers().at(-1)!.visit('/step');
    expect(app.layers()).toEqual([]);
    expect(app.visible().component).toBe(`steps/Step${MAX_LAYER_DEPTH + 1}`);
  });
});

describe('Layers — forms and the server', () => {
  it('a failed form in a layer stays in the layer: the same layer (its key) replaces it in place — the page and history untouched', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (_url, init) =>
      init.method === 'PUT' ? pageResponse(layer('/users/1/edit', { errors: { name: 'Too short.' } })) : pageResponse(layer('/users/1/edit', { errors: {} }));
    const app = profile(win);
    const base = app.navigator.page;
    await app.navigator.visit('/users/1/edit', { layer: true });
    const [edit] = app.layers();
    const errors: unknown[] = [];

    await edit!.visit('/users/1', { method: 'put', data: { name: 'A' }, onError: (failed) => errors.push(failed) });
    expect(errors).toEqual([{ name: 'Too short.' }]);
    expect(app.layers()).toEqual([edit]); // the same object: its state (what was typed) stays
    expect(edit!.page.props).toEqual({ errors: { name: 'Too short.' } });
    expect(app.navigator.page).toBe(base);
    expect(win.entries).toHaveLength(2);
    expect(win.requests.at(-1)!.headers).toMatchObject({ [REGION_HEADER]: 'layer' });
  });

  it('closeLayer({ reload }) — closes the layer, then exactly one partial request of what is beneath', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (url, init) => {
      if (init.method === 'PUT') return closeResponse({ layers: 1, reload: ['profile'] });
      if (url.endsWith('/edit')) return pageResponse(layer('/users/1/edit'));
      return pageResponse(page('/users/1', { profile: { name: 'Grace' } }, 'users/Show'));
    };
    const app = boot(win, page('/users/1', { profile: { name: 'Ada' }, other: 1 }, 'users/Show'));
    await app.navigator.visit('/users/1/edit', { layer: true });
    const successes: string[] = [];
    const requests = win.requests.length;

    const shown = await app.layers()[0]!.visit('/users/1', { method: 'put', data: { name: 'Grace' }, onSuccess: (next) => successes.push(next.component) });
    expect(app.layers()).toEqual([]);
    expect(win.requests.slice(requests).map((request) => [request.method, request.headers[PARTIAL_DATA_HEADER]])).toEqual([
      ['PUT', undefined],
      ['GET', 'profile'],
    ]);
    expect(app.navigator.page.props).toEqual({ profile: { name: 'Grace' }, other: 1 });
    expect(shown?.component).toBe('users/Show');
    expect(successes).toEqual(['users/Show']);
    expect(win.current.url).toBe(`${ORIGIN}/users/1`);
  });

  it('closing the top of two reloads both beneath, the page first — what the closed layer changed shows on each', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (url, init) => {
      if (init.method === 'DELETE') return closeResponse({ layers: 1, reload: ['links'] });
      if (url.endsWith('/remove')) return pageResponse(layer('/users/1/links/5/remove', {}, 'users/RemoveLink'));
      if (url.endsWith('/edit')) return pageResponse(layer('/users/1/edit', { links: [] }));
      return pageResponse(page('/users/1', { links: [] }, 'users/Show'));
    };
    const app = boot(win, page('/users/1', { links: ['a'], name: 'Ada' }, 'users/Show'));
    await app.navigator.visit('/users/1/edit', { layer: true });
    const [edit] = app.layers();
    await edit!.visit('/users/1/links/5/remove');
    const requests = win.requests.length;
    await app.layers()[1]!.visit('/users/1/links/5', { method: 'delete' });
    expect(app.layers()).toEqual([edit]);
    expect(win.requests.slice(requests).map((request) => [request.method, request.url.replace(ORIGIN, ''), request.headers[PARTIAL_DATA_HEADER], request.headers[REGION_HEADER]])).toEqual([
      ['DELETE', '/users/1/links/5', undefined, 'layer'],
      ['GET', '/users/1', 'links', undefined],
      ['GET', '/users/1/edit', 'links', 'layer'],
    ]);
    expect(app.navigator.page.props).toEqual({ links: [], name: 'Ada' });
  });

  it('the page under a layer keeps polling: its reloads land in place — the layer and its entry stay', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (url) => (url.endsWith('/edit') ? pageResponse(layer('/users/1/edit')) : pageResponse(page('/users/1', { activity: ['new'] }, 'users/Show')));
    const app = boot(win, page('/users/1', { activity: ['old'], name: 'Ada' }, 'users/Show'));
    await app.navigator.visit('/users/1/edit', { layer: true });

    await app.navigator.reload({ only: ['activity'], async: true });
    expect(win.requests.at(-1)!.url).toBe(`${ORIGIN}/users/1`); // the page's URL, not the window's
    expect(app.navigator.page.props).toEqual({ activity: ['new'], name: 'Ada' });
    expect(app.layers()).toHaveLength(1);
    expect(win.current.url).toBe(`${ORIGIN}/users/1/edit`);
    expect(win.entries).toHaveLength(2);
  });

  it('a layer’s own deferred props load as the layer’s request — and land in it', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (_url, init) => {
      const headers = init.headers as Record<string, string>;
      if (headers[PARTIAL_DATA_HEADER] === 'links') return pageResponse(layer('/users/1/edit', { links: ['a'] }));
      return pageResponse({ ...layer('/users/1/edit', { name: 'Ada' }), deferredProps: { default: ['links'] } });
    };
    const app = profile(win);
    await app.navigator.visit('/users/1/edit', { layer: true });
    await tick();
    expect(app.layers()[0]!.page.props).toEqual({ name: 'Ada', links: ['a'] });
    expect(win.requests.at(-1)!.headers).toMatchObject({ [REGION_HEADER]: 'layer', [PARTIAL_DATA_HEADER]: 'links' });
  });

  it('a layer shown once (an action’s answer) is forgotten when it leaves — Forward asks the server, what is beneath reloads', async () => {
    const win = new FakeWindow(`${ORIGIN}/settings/tokens`);
    win.handler = (url, init) => {
      if (init.method === 'POST') return pageResponse(layer('/settings/tokens', { plainText: 'bc_1|secret' }, 'auth/NewToken', { key: 'tokens.create', once: true, base: '/settings/tokens' }));
      if (url.endsWith('/create')) return pageResponse(layer('/settings/tokens/create', {}, 'auth/CreateToken', { key: 'tokens.create', base: '/settings/tokens' }));
      return pageResponse(page('/settings/tokens', { tokens: ['ci'] }, 'auth/Tokens'));
    };
    const app = boot(win, page('/settings/tokens', { tokens: [] }, 'auth/Tokens'));
    await app.navigator.visit('/settings/tokens/create', { layer: true });
    await app.layers()[0]!.visit('/settings/tokens', { method: 'post', data: { name: 'ci' } });
    // The answer replaced the form (the same key) — in place.
    expect(app.layers().map((open) => [open.page.component, open.once])).toEqual([['auth/NewToken', true]]);
    expect(win.entries).toHaveLength(2);

    win.back();
    await tick();
    await tick();
    expect(app.layers()).toEqual([]);
    // The list beneath reloaded: the action changed it.
    expect(app.navigator.page.props).toEqual({ tokens: ['ci'] });
    const requests = win.requests.length;

    win.forward();
    await tick();
    await tick();
    // Not from memory: the server was asked, and its GET is the list — the plain text is gone for good.
    expect(win.requests.length).toBeGreaterThan(requests);
    expect(JSON.stringify(app.layers().map((open) => open.page))).not.toContain('bc_1|secret');
    expect(JSON.stringify(app.shown)).not.toContain('bc_1|secret');
  });
});

describe('Layers — deep links, sign-out, prefetch', () => {
  it('a deep link’s document brings the page and its layers: one history entry, closing it replaces the entry with the page', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1/edit`);
    const app = boot(win, { ...page('/users/1', { name: 'Ada' }, 'users/Show'), layers: [layer('/users/1/edit', { profile: 1 })] });
    expect(app.navigator.page).toMatchObject({ component: 'users/Show' });
    expect(app.navigator.page).not.toHaveProperty('layers');
    expect(app.layers().map((open) => open.page.component)).toEqual(['users/Edit']);
    expect(JSON.parse(win.current.state).layer.depth).toBe(1);

    await app.layers()[0]!.close();
    expect(app.layers()).toEqual([]);
    expect(win.entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/users/1`]);
    expect(win.requests).toEqual([]);
  });

  it('closing a deep-linked layer over the neutral surface (E54) visits its base — the server decides what it shows', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/2/card`);
    win.handler = () => new Response('', { status: 403 });
    const app = boot(win, { ...page('/users/2', {}, LAYER_BACKDROP), layers: [layer('/users/2/card', {}, 'users/Card', { base: '/users/2' })] });
    await app.layers()[0]!.close();
    expect(win.requests.map((request) => request.url)).toEqual([`${ORIGIN}/users/2`]);
  });

  it('counter-check: signing out with a layer open (409) drops it — Back finds no layer in memory, the server is asked', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (_url, init) =>
      init.method === 'POST'
        ? new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login' } })
        : pageResponse(layer('/users/1/edit', { secret: 'ada@example.com' }));
    const app = profile(win);
    await app.navigator.visit('/users/1/edit', { layer: true });
    const [open] = app.layers();
    await app.navigator.visit('/logout', { method: 'post' });

    expect(win.loads).toEqual(['assign /login']);
    expect(open!.closed).toBe(true);
    expect(app.navigator.layers).toEqual([]);
    expect(app.navigator.cachedPages).toBe(0);
  });

  it('prefetches a layer as a layer’s request — the visit that opens it takes it', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(layer('/users/1/edit'));
    const app = profile(win);
    await app.navigator.prefetch('/users/1/edit', { layer: true });
    expect(win.requests.at(-1)!.headers).toMatchObject({ [REGION_HEADER]: 'layer', purpose: 'prefetch' });
    await app.navigator.visit('/users/1/edit', { layer: true });
    expect(win.requests).toHaveLength(1);
    expect(app.layers()).toHaveLength(1);
  });
});

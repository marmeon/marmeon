// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1" }
/**
 * The adapter contract is real: a complete "UI adapter" in a dozen lines of plain DOM — it renders a page as its
 * component name and props in text — drives the client core through a visit, Back/Forward, deferred props, a partial
 * reload and a 409, and through what W5b added: islands (loaded, and hydrated from the SSR stream's data block), layers
 * (Back closes, Forward opens from memory), an action with an optimistic patch and its rollback, a flash message fired
 * once, the navigation guard, an instant visit's placeholder, remembered state and a postponed new build — with no UI
 * framework anywhere. A Vue (or Svelte, or Solid) adapter is this plus components.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_HEADER,
  ACTION_REDIRECT_HEADER,
  FLASH_HEADER,
  LOCATION_HEADER,
  PAGE_HEADER,
  PAGE_SCRIPT_ID,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  REGION_HEADER,
  REGION_STATUS_HEADER,
  RELOAD_HEADER,
  scriptJson,
  VALIDATE_HEADER,
  VALIDATED_HEADER,
  type PageObject,
  type RegionResult,
} from '../page.ts';
import {
  actions,
  firstErrors,
  hasServerMarkup,
  isHistoryState,
  liveValidationOnFirstUse,
  loadPageMessages,
  Navigator,
  optimistic,
  PROGRESS_ATTRIBUTE,
  queryState,
  readInitialPage,
  regionInitial,
  remember,
  rootElement,
  showProgress,
  visitUrlOf,
  type PageMessages,
  type RegionOwner,
} from './index.ts';

/** The whole adapter: the hydration entry, rendering a page object, the progress bar. */
async function createTextApp(rootId = 'app') {
  const initialPage = readInitialPage();
  const root = await rootElement(rootId);
  const render = async (page: PageObject) => {
    root.textContent = `${page.component} ${JSON.stringify(page.props)}`;
  };
  // "Hydrating" plain text means keeping the server's; without markup the adapter renders the page itself.
  if (!hasServerMarkup(root)) await render(initialPage);
  const navigator = new Navigator({ initialPage, render });
  const stops = [navigator.start(), showProgress(navigator, { delay: 0 })];
  return { navigator, root, stop: () => stops.forEach((stop) => stop()) };
}

// ---- a server, as far as the protocol goes ----

const users: Record<string, string> = { '1': 'Ada', '2': 'Grace' };
const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
let slow: Promise<void> | undefined;

const page = (component: string, url: string, props: Record<string, unknown>, extra: Partial<PageObject> = {}): PageObject => ({ component, url, props, version: 'v1', ...extra });

function respond(body: PageObject, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { [PAGE_HEADER]: 'true', 'content-type': 'application/json' } });
}

/** `/users/:id` with a deferred `activity` and an optional `stats` (only by name, in a partial reload); `POST /logout` → 409. */
async function server(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, 'https://app.test');
  const headers = { ...(init.headers as Record<string, string>) };
  requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search, headers });
  await slow;
  if (url.pathname === '/logout' && init.method === 'POST') {
    // Signing out: ClientHistory.clear() — the client must load the next page fully and forget what it kept.
    return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login' } });
  }
  const id = /^\/users\/(\d+)$/.exec(url.pathname)?.[1];
  if (!id || !users[id]) return new Response('not found', { status: 404 });
  const all = { user: users[id], activity: [`${users[id]} signed in`], stats: { links: Number(id) * 3 } };
  const partial = headers[PARTIAL_COMPONENT_HEADER] === 'users/Show' ? headers[PARTIAL_DATA_HEADER]?.split(',') : undefined;
  if (partial) return respond(page('users/Show', url.pathname, Object.fromEntries(partial.map((key) => [key, all[key as keyof typeof all]]))));
  return respond(page('users/Show', url.pathname, { user: all.user }, { deferredProps: { default: ['activity'] } }));
}

function serverRenderedDocument(initial: PageObject): void {
  document.head.innerHTML = `<script id="${PAGE_SCRIPT_ID}" type="application/json">${JSON.stringify(initial)}</script>`;
  document.body.innerHTML = `<div id="app">${initial.component} ${JSON.stringify(initial.props)}</div>`;
}

afterEach(() => {
  requests.length = 0;
  slow = undefined;
  vi.restoreAllMocks();
});

describe('a UI adapter on the client core alone (no UI framework)', () => {
  it('visits, goes back and forward, loads deferred props, reloads partially and follows a 409', async () => {
    window.fetch = server as typeof fetch;
    document.cookie = 'XSRF-TOKEN=token-from-the-cookie';
    const loads: string[] = [];
    window.location.assign = (url: string | URL) => void loads.push(String(url));
    serverRenderedDocument(page('users/Show', '/users/1', { user: 'Ada' }));

    const { navigator, root, stop } = await createTextApp();
    const text = () => root.textContent ?? '';
    expect(text()).toBe('users/Show {"user":"Ada"}'); // the server's markup, kept

    // A visit: the next page as JSON, rendered by the adapter; the history entry holds no props (E36).
    await navigator.visit('/users/2');
    expect(requests.at(-1)).toMatchObject({ method: 'GET', url: '/users/2', headers: { [PAGE_HEADER]: 'true', 'x-bespoke-version': 'v1' } });
    expect(window.location.pathname).toBe('/users/2');
    expect(text()).toContain('"user":"Grace"');
    expect(isHistoryState(window.history.state)).toBe(true);
    expect(JSON.stringify(window.history.state)).not.toContain('Grace');

    // Deferred props: loaded right after the page showed, by a partial reload of their group, merged in.
    await vi.waitFor(() => expect(text()).toBe('users/Show {"user":"Grace","activity":["Grace signed in"]}'));
    expect(requests.at(-1)!.headers).toMatchObject({ [PARTIAL_COMPONENT_HEADER]: 'users/Show', [PARTIAL_DATA_HEADER]: 'activity' });

    // Back and Forward: from the in-memory cache — no request, the page as it was left.
    const asked = requests.length;
    window.history.back();
    await vi.waitFor(() => expect(text()).toContain('"user":"Ada"'));
    expect(window.location.pathname).toBe('/users/1');
    window.history.forward();
    await vi.waitFor(() => expect(text()).toContain('"user":"Grace"'));
    expect(requests.length).toBe(asked);

    // A partial reload: only `stats` is asked for and sent, and merged into the props the page has.
    let release!: () => void;
    slow = new Promise((done) => (release = done));
    const reloading = navigator.reload({ only: ['stats'] });
    // The progress bar of the core shows while it runs (delay 0) — plain DOM, no adapter code.
    await vi.waitFor(() => expect(document.querySelector(`[${PROGRESS_ATTRIBUTE}]`)).not.toBeNull());
    release();
    await reloading;
    expect(requests.at(-1)!.headers).toMatchObject({ [PARTIAL_COMPONENT_HEADER]: 'users/Show', [PARTIAL_DATA_HEADER]: 'stats' });
    expect(text()).toBe('users/Show {"user":"Grace","activity":["Grace signed in"],"stats":{"links":6}}');

    // A 409 with a location (signing out, a new build): a full page load there, every page in memory dropped.
    expect(navigator.cachedPages).toBeGreaterThan(0);
    const ended = await navigator.visit('/logout', { method: 'post' });
    expect(requests.at(-1)).toMatchObject({ method: 'POST', url: '/logout', headers: { 'x-xsrf-token': 'token-from-the-cookie' } });
    expect(ended).toBeUndefined();
    expect(loads).toEqual(['/login']);
    expect(navigator.cachedPages).toBe(0);
    stop();
  });

  it('renders islands: each a region of the page — loaded after it, kept in its entry, shown again on Back without a request', async () => {
    window.fetch = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'https://app.test');
      const headers = { ...(init.headers as Record<string, string>) };
      requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search, headers });
      if (headers[REGION_HEADER] !== 'island') return server(input, init);
      // The server's side (packages/server): the island's region object — or, for the admins' island, its outcome.
      if (url.pathname === '/islands/admins') return new Response(null, { status: 204, headers: { [REGION_STATUS_HEADER]: 'forbidden' } });
      const body = { component: 'dashboard/SignIns', props: { who: ['Ada'] }, url: url.pathname + url.search, version: 'v1' };
      return new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: 'true', [REGION_HEADER]: 'island', 'content-type': 'application/json' } });
    }) as typeof fetch;
    serverRenderedDocument(page('users/Show', '/users/1', { user: 'Ada' }));
    // The adapter: a page renders its islands into elements of their own, from the regions of its entry (`owner`).
    const initialPage = readInitialPage();
    const root = await rootElement('app');
    let navigator!: Navigator;
    const renderIsland = (element: Element, url: string, owner = navigator.regionOwner) => {
      const region = navigator.region(url, { owner });
      const draw = () => {
        const { status, region: shown } = region.snapshot;
        element.textContent = shown ? `${shown.component} ${JSON.stringify(shown.props)}` : status;
      };
      region.subscribe(draw);
      draw();
      void region.load();
    };
    navigator = new Navigator({
      initialPage,
      render: async (next, { owner }) => {
        root.innerHTML = `<p>${next.component}</p><div id="island"></div><div id="admins"></div>`;
        renderIsland(root.querySelector('#island')!, '/islands/sign-ins?limit=5', owner);
        renderIsland(root.querySelector('#admins')!, '/islands/admins', owner);
      },
    });
    const stop = navigator.start();
    await navigator.visit('/users/2');
    const island = () => root.querySelector('#island')!.textContent;
    await vi.waitFor(() => expect(island()).toBe('dashboard/SignIns {"who":["Ada"]}'));
    expect(root.querySelector('#admins')!.textContent).toBe('forbidden');
    expect(requests.filter((request) => request.headers[REGION_HEADER] === 'island').map((request) => request.url)).toEqual(['/islands/sign-ins?limit=5', '/islands/admins']);

    await navigator.visit('/users/1');
    const asked = requests.length;
    window.history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/users/2'));
    await vi.waitFor(() => expect(island()).toBe('dashboard/SignIns {"who":["Ada"]}'));
    expect(root.querySelector('#admins')!.textContent).toBe('forbidden');
    // From the entry's memory: the island requests not again — the page's deferred props neither.
    expect(requests.slice(asked).filter((request) => request.headers[REGION_HEADER] === 'island')).toEqual([]);
    expect(JSON.stringify(window.history.state)).not.toContain('Ada');
    stop();
  });

  it('renders layers (E53): each over the page in an element of its own — Back closes the top one, the page untouched', async () => {
    window.fetch = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'https://app.test');
      const headers = { ...(init.headers as Record<string, string>) };
      requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search, headers });
      if (url.pathname !== '/users/1/edit') return server(input, init);
      // The server's side: a layer's page object (`this.view(…).layer({ base })`).
      return respond(page('users/Edit', '/users/1/edit', { name: 'Ada' }, { layer: { key: 'users/Edit', base: '/users/1' } }));
    }) as typeof fetch;
    window.history.replaceState(null, '', '/users/1');
    serverRenderedDocument(page('users/Show', '/users/1', { user: 'Ada' }));
    const initialPage = readInitialPage();
    const root = await rootElement('app');
    let pageRenders = 0;
    // The adapter: the page as before — and, when only the layers change (the same page), the layers alone.
    let shown: PageObject | undefined;
    const navigator = new Navigator({
      initialPage,
      render: async (next, { layers }) => {
        if (next !== shown) {
          shown = next;
          pageRenders++;
          root.innerHTML = `<p>${next.component}</p><div id="layers"></div>`;
        }
        root.querySelector('#layers')!.innerHTML = layers.map((layer) => `<dialog open data-depth="${layer.depth}">${layer.page.component}</dialog>`).join('');
      },
    });
    const stop = navigator.start();
    const dialogs = () => [...root.querySelectorAll('dialog')].map((dialog) => dialog.textContent);
    await navigator.visit('/users/1/edit', { layer: true });
    expect(dialogs()).toEqual(['users/Edit']);
    expect(window.location.pathname).toBe('/users/1/edit');
    const renders = pageRenders;

    window.history.back();
    await vi.waitFor(() => expect(dialogs()).toEqual([]));
    expect(window.location.pathname).toBe('/users/1');
    expect(pageRenders).toBe(renders); // the page was not rendered again
    expect(JSON.stringify(window.history.state)).not.toContain('Ada');
    stop();
  });

  it('hydrates a streamed island from its data block (E49): no request — and Back shows it from the entry’s memory', async () => {
    window.fetch = server as typeof fetch;
    window.history.replaceState(null, '', '/users/1');
    // What the SSR stream left in the document: the island's markup and, in its boundary, the `RegionResult` the kernel resolved.
    const streamed: RegionResult = { status: 'ready', region: { component: 'dashboard/SignIns', props: { who: ['Ada'] }, url: '/islands/sign-ins', version: 'v1' } };
    serverRenderedDocument(page('users/Show', '/users/1', { user: 'Ada' }));
    document.getElementById('app')!.innerHTML = `<p>users/Show</p><div id="island">dashboard/SignIns {"who":["Ada"]}</div><script type="application/json" id="bespoke-island-0">${scriptJson(streamed)}</script>`;
    const initialPage = readInitialPage();
    const root = await rootElement('app');
    let navigator!: Navigator;
    const renderIsland = (element: Element, owner: RegionOwner) => {
      // The adapter reads the data block once, while hydrating — a later render (Back) finds the region in the entry's memory.
      const block = document.getElementById('bespoke-island-0');
      const initial = block ? regionInitial(JSON.parse(block.textContent!) as RegionResult) : undefined;
      block?.remove();
      const region = navigator.region('/islands/sign-ins', { owner, initial });
      const draw = () => {
        const shown = region.snapshot.region;
        element.textContent = shown ? `${shown.component} ${JSON.stringify(shown.props)}` : region.snapshot.status;
      };
      region.subscribe(draw);
      draw();
      void region.load();
    };
    navigator = new Navigator({
      initialPage,
      render: async (next, { owner }) => {
        root.innerHTML = `<p>${next.component}</p><div id="island"></div>`;
        if (next.component === 'users/Show' && next.url === '/users/1') renderIsland(root.querySelector('#island')!, owner);
      },
    });
    const stop = navigator.start();
    renderIsland(root.querySelector('#island')!, navigator.regionOwner);
    const island = () => root.querySelector('#island')!.textContent;
    expect(island()).toBe('dashboard/SignIns {"who":["Ada"]}');
    await navigator.visit('/users/2');
    window.history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/users/1'));
    await vi.waitFor(() => expect(island()).toBe('dashboard/SignIns {"who":["Ada"]}'));
    expect(requests.filter((request) => request.headers[REGION_HEADER] === 'island')).toEqual([]);
    stop();
  });

  it('opens a layer, Back closes it, Forward opens it again from memory — no request either way', async () => {
    window.fetch = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'https://app.test');
      const headers = { ...(init.headers as Record<string, string>) };
      requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search, headers });
      if (url.pathname !== '/users/1/edit') return server(input, init);
      return respond(page('users/Edit', '/users/1/edit', { name: 'Ada' }, { layer: { key: 'users/Edit', base: '/users/1' } }));
    }) as typeof fetch;
    window.history.replaceState(null, '', '/users/1');
    serverRenderedDocument(page('users/Show', '/users/1', { user: 'Ada' }));
    const root = await rootElement('app');
    const navigator = new Navigator({
      initialPage: readInitialPage(),
      render: async (next, { layers }) => {
        root.innerHTML = `<p>${next.component}</p>${layers.map((layer) => `<dialog open>${layer.page.component} ${JSON.stringify(layer.view.props)}</dialog>`).join('')}`;
      },
    });
    const stop = navigator.start();
    const dialogs = () => [...root.querySelectorAll('dialog')].map((dialog) => dialog.textContent);
    await navigator.visit('/users/1/edit', { layer: true });
    expect(requests.at(-1)!.headers).toMatchObject({ [REGION_HEADER]: 'layer' });
    expect(window.history.state).toMatchObject({ layer: { depth: 1 } });
    const asked = requests.length;
    window.history.back();
    await vi.waitFor(() => expect(dialogs()).toEqual([]));
    window.history.forward();
    await vi.waitFor(() => expect(dialogs()).toEqual(['users/Edit {"name":"Ada"}']));
    expect(window.location.pathname).toBe('/users/1/edit');
    expect(requests.length).toBe(asked);
    stop();
  });

  it('runs an action with an optimistic patch (E59): shown at once, rolled back on a 422 — kept, with its flash, on success', async () => {
    let answer: 'invalid' | 'ok' = 'invalid';
    let release!: () => void;
    window.fetch = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'https://app.test');
      const headers = { ...(init.headers as Record<string, string>) };
      requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search, headers });
      if (headers[ACTION_HEADER] !== 'true') return server(input, init);
      await new Promise<void>((done) => (release = done));
      if (answer === 'invalid') return new Response(JSON.stringify({ message: 'Invalid.', errors: { link: ['Not yours.'] } }), { status: 422, headers: { 'content-type': 'application/json' } });
      // The kernel's answer to an action that redirected: 204 + where to, and the flash messages it took (E60).
      const flash = [{ id: 'f1', key: 'toast', data: { message: 'Removed.' } }];
      return new Response(null, { status: 204, headers: { [ACTION_REDIRECT_HEADER]: '/users/1', [FLASH_HEADER]: encodeURIComponent(JSON.stringify(flash)) } });
    }) as typeof fetch;
    window.history.replaceState(null, '', '/users/1');
    serverRenderedDocument(page('users/Show', '/users/1', { links: ['blog', 'code'] }));
    const { navigator, root, stop } = await createTextApp();
    const toasts: string[] = [];
    navigator.on('flash', (message) => toasts.push((message.data as { message: string }).message));
    // The adapter attaches the features where it uses them (E70): actions, and the patches of the page's entry.
    const run = navigator.use(actions).run;
    const pageTarget = () => navigator.use(optimistic).target(navigator.regionOwner.entry!);
    const withoutCode = { target: pageTarget(), patch: (props: Readonly<Record<string, unknown>>) => ({ links: (props.links as string[]).filter((link) => link !== 'code') }) };

    const failing = run('/users/1/links/code', { method: 'delete', optimistic: withoutCode });
    await vi.waitFor(() => expect(root.textContent).toBe('users/Show {"links":["blog"]}')); // at once, before the answer
    release();
    expect(await failing).toMatchObject({ ok: false, kind: 'invalid', errors: { link: ['Not yours.'] } });
    expect(root.textContent).toBe('users/Show {"links":["blog","code"]}'); // rolled back
    expect(requests.at(-1)!.headers).toMatchObject({ [ACTION_HEADER]: 'true', accept: 'application/json' });

    answer = 'ok';
    const succeeding = run('/users/1/links/code', { method: 'delete', optimistic: { ...withoutCode, target: pageTarget() } });
    await vi.waitFor(() => expect(root.textContent).toBe('users/Show {"links":["blog"]}'));
    release();
    expect(await succeeding).toMatchObject({ ok: true, kind: 'redirect', redirect: '/users/1' });
    expect(root.textContent).toBe('users/Show {"links":["blog"]}'); // no reload asked: the patch is the state now
    expect(toasts).toEqual(['Removed.']);
    expect(window.location.pathname).toBe('/users/1'); // an action never navigates
    expect(JSON.stringify(window.history.state)).not.toContain('blog');
    stop();
  });

  it('fires a flash message once (E60): not again for a partial reload that brings it again, nor for Back/Forward', async () => {
    const toast = { id: 'saved-1', key: 'toast', data: { message: 'Saved.' } };
    window.fetch = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'https://app.test');
      const headers = { ...(init.headers as Record<string, string>) };
      requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search, headers });
      if (url.pathname === '/users/1' && init.method === 'PUT') return respond(page('users/Show', '/users/1', { user: 'Ada L.' }, { flash: [toast] }));
      // A race of two requests delivered the same message twice: by its id, it fires once.
      if (headers[PARTIAL_DATA_HEADER]) return respond(page('users/Show', '/users/1', { stats: { links: 3 } }, { flash: [toast] }));
      return server(input, init);
    }) as typeof fetch;
    window.history.replaceState(null, '', '/users/1');
    serverRenderedDocument(page('users/Show', '/users/1', { user: 'Ada' }));
    const { navigator, stop } = await createTextApp();
    const toasts: string[] = [];
    navigator.onFlash('toast', (message) => toasts.push((message.data as { message: string }).message));
    await navigator.visit('/users/1', { method: 'put', data: { name: 'Ada L.' } });
    expect(toasts).toEqual(['Saved.']);
    await navigator.reload({ only: ['stats'] });
    await navigator.visit('/users/2');
    window.history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/users/1'));
    window.history.forward();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/users/2'));
    expect(toasts).toEqual(['Saved.']);
    // The core keeps no message with a page: the history entry and the page in memory hold none.
    expect(JSON.stringify(window.history.state)).not.toContain('Saved');
    stop();
  });

  it('guards unsaved changes (E64): the adapter’s dialog says Stay — no request, Back undone; Leave — the visit goes', async () => {
    window.fetch = server as typeof fetch;
    window.history.replaceState(null, '', '/users/1');
    serverRenderedDocument(page('users/Show', '/users/1', { user: 'Ada' }));
    const root = await rootElement('app');
    // The adapter's confirm: its own dialog (here: an answer queue) — the core decides what the answer means.
    const asked: string[] = [];
    let answer = false;
    const navigator = new Navigator({
      initialPage: readInitialPage(),
      render: async (next) => void (root.textContent = `${next.component} ${JSON.stringify(next.props)}`),
      confirm: (request) => (asked.push(`${request.kind}: ${request.message}`), answer),
    });
    const stop = navigator.start();
    await navigator.visit('/users/2');
    await vi.waitFor(() => expect(root.textContent).toContain('activity')); // its deferred props are in
    let dirty = true;
    const lift = navigator.guard({ message: 'Unsaved changes.', active: () => dirty });
    const sent = requests.length;
    expect(await navigator.visit('/users/1')).toBeUndefined();
    expect(requests.length).toBe(sent); // Stay: nothing sent
    expect(asked).toEqual(['leave: Unsaved changes.']);

    // Back: the browser went already — the core goes forward again and asks; Stay keeps the page and its URL.
    window.history.back();
    await vi.waitFor(() => expect(asked.length).toBe(2));
    await vi.waitFor(() => expect(window.location.pathname).toBe('/users/2'));
    expect(root.textContent).toContain('"user":"Grace"');

    answer = true;
    await navigator.visit('/users/1');
    expect(window.location.pathname).toBe('/users/1');
    expect(asked.length).toBe(3);
    dirty = false;
    await navigator.visit('/users/2');
    expect(asked.length).toBe(3); // nothing unsaved: nothing asked
    lift();
    stop();
  });

  it('shows an instant visit’s placeholder, remembers state per entry and postpones a new build — all from the core', async () => {
    let release!: () => void;
    let newBuild = false;
    window.fetch = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'https://app.test');
      requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search, headers: { ...(init.headers as Record<string, string>) } });
      if (newBuild) return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: url.pathname, [RELOAD_HEADER]: 'version' } });
      if (url.pathname === '/users/2') await new Promise<void>((done) => (release = done));
      return server(input, init);
    }) as typeof fetch;
    const loads: string[] = [];
    window.location.assign = (url: string | URL) => void loads.push(String(url));
    window.history.replaceState(null, '', '/users/1');
    serverRenderedDocument(page('users/Show', '/users/1', { user: 'Ada' }));
    const root = await rootElement('app');
    let owner!: RegionOwner;
    const navigator = new Navigator({
      initialPage: readInitialPage(),
      // The adapter: a placeholder is the view's own (`users/Show` → "Loading <name> …"), never the view with partial props.
      render: async (next, options) => {
        if (options.placeholder) return void (root.textContent = `Loading ${String(next.props.name)} …`);
        owner = options.owner;
        root.textContent = `${next.component} ${JSON.stringify(next.props)}`;
      },
    });
    owner = navigator.regionOwner;
    const stop = navigator.start();
    // Remembered state of /users/1's entry (E63) — the feature attached where a component remembers.
    const remembered = () => navigator.use(remember).of(owner.entry!);
    remembered().set('tab', 'links');

    const visiting = navigator.visit('/users/2', { instant: { component: 'users/Show', props: { name: 'Grace' } } });
    await vi.waitFor(() => expect(root.textContent).toBe('Loading Grace …'));
    expect(window.location.pathname).toBe('/users/1'); // the entry comes with the page
    release();
    await visiting;
    expect(root.textContent).toContain('"user":"Grace"');
    expect(window.location.pathname).toBe('/users/2');
    expect(remembered().has('tab')).toBe(false);
    window.history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/users/1'));
    await vi.waitFor(() => expect(remembered().get('tab')).toBe('links'));

    // A new build (409 + `x-bespoke-reload: version`): the adapter keeps the page — "a new version is available".
    newBuild = true;
    navigator.on('version', (event) => event.preventDefault());
    expect(await navigator.visit('/users/2')).toBeUndefined();
    expect(loads).toEqual([]);
    expect(navigator.newVersion).toBe('/users/2');
    expect(root.textContent).toContain('"user":"Ada"');
    navigator.reloadForNewVersion();
    expect(loads).toEqual(['/users/2']);
    stop();
  });

  it('keeps URL state with the query-state feature, attached where it is used (E55, E70)', async () => {
    window.fetch = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'https://app.test');
      requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search, headers: { ...(init.headers as Record<string, string>) } });
      const sort = url.searchParams.get('sort') ?? 'name';
      return respond(page('people/Index', url.pathname + url.search, { people: sort === 'name' ? ['Ada', 'Grace'] : ['Grace', 'Ada'] }, { query: { sort }, queryDefaults: { sort: 'name' } }));
    }) as typeof fetch;
    window.history.replaceState(null, '', '/people');
    serverRenderedDocument(page('people/Index', '/people', { people: ['Ada', 'Grace'] }, { query: {}, queryDefaults: { sort: 'name' } }));
    const { navigator, root, stop } = await createTextApp();
    // The adapter attaches it where a component shows query state — an app without it carries none of its code.
    const state = navigator.use(queryState).create<{ sort: string }>({ only: ['people'] });
    expect(state.value()).toEqual({ sort: 'name' });
    state.set({ sort: '-name' });
    expect(state.value()).toEqual({ sort: '-name' }); // at once — the URL follows with the visit
    await vi.waitFor(() => expect(root.textContent).toBe('people/Index {"people":["Grace","Ada"]}'));
    expect(requests.at(-1)).toMatchObject({ url: '/people?sort=-name', headers: { [PARTIAL_DATA_HEADER]: 'people' } });
    expect(window.location.search).toBe('?sort=-name');
    state.set({ sort: undefined }); // back to the default: no query at all
    await vi.waitFor(() => expect(window.location.search).toBe(''));
    state.dispose();
    stop();
  });

  it('renders the page itself when the server sent no markup (SSR failed or ssr = false)', async () => {
    serverRenderedDocument(page('users/Show', '/users/1', { user: 'Ada' }));
    document.getElementById('app')!.innerHTML = '\n  ';
    const { root, stop } = await createTextApp();
    expect(root.textContent).toBe('users/Show {"user":"Ada"}');
    stop();
  });

  it('shares link and form behaviour: which clicks visit, the first error per field', () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
    const location = { href: 'https://app.test/users/1', origin: 'https://app.test' };
    expect(visitUrlOf(click, '/users/2?tab=links#top', undefined, location)).toBe('/users/2?tab=links#top');
    expect(visitUrlOf({ ...click, metaKey: true }, '/users/2', undefined, location)).toBeUndefined(); // a new tab
    expect(visitUrlOf(click, '/users/2', '_blank', location)).toBeUndefined();
    expect(visitUrlOf(click, 'https://example.com/', undefined, location)).toBeUndefined();
    expect(visitUrlOf({ ...click, defaultPrevented: true }, '/users/2', undefined, location)).toBeUndefined();
    expect(firstErrors(page('users/Edit', '/users/1/edit', { errors: { name: ['Too short.', 'Taken.'], bio: 'Too long.' } }))).toEqual({ name: 'Too short.', bio: 'Too long.' });
  });

  it('validates a plain form live (E62): an input left shows the server’s message in the DOM, the password never leaves', async () => {
    const sent: { fields: string | null; body: string }[] = [];
    window.fetch = (async (_input: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string>;
      sent.push({ fields: headers[VALIDATE_HEADER] ?? null, body: String(init.body) });
      const email = (JSON.parse(String(init.body)) as { email?: string }).email;
      return email === 'ada@example.com'
        ? new Response(JSON.stringify({ errors: { email: ['Taken.'] } }), { status: 422, headers: { 'content-type': 'application/json', [VALIDATED_HEADER]: 'email' } })
        : new Response(null, { status: 204, headers: { [VALIDATED_HEADER]: 'email' } });
    }) as typeof fetch;
    serverRenderedDocument(page('auth/Register', '/register', {}));
    const { navigator, stop } = await createTextApp();
    // The adapter's form: plain inputs, an element per error — the core decides when to ask and what lands.
    document.body.insertAdjacentHTML('beforeend', '<form><input name="email"><input name="password" type="password"><small id="email-error"></small></form>');
    const form = document.querySelector('form')!;
    const data = () => Object.fromEntries(new FormData(form)) as Record<string, unknown>;
    // Its code loads on the form's first use (E74): the first input fetches the feature's chunk.
    const live = liveValidationOnFirstUse(navigator, '/register', {
      method: 'post',
      data,
      onResult: (outcome) => {
        document.getElementById('email-error')!.textContent = outcome.kind === 'invalid' ? (outcome.errors.email?.[0] ?? '') : '';
      },
    });
    form.addEventListener('input', (event) => live.changed((event.target as HTMLInputElement).name));
    form.addEventListener('focusout', (event) => live.blurred((event.target as HTMLInputElement).name));
    const fill = (name: string, value: string) => {
      const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    };
    fill('password', 'hunter2-secret');
    fill('email', 'ada@example.com');
    await vi.waitFor(() => expect(document.getElementById('email-error')!.textContent).toBe('Taken.'));
    fill('email', 'grace@example.com');
    await vi.waitFor(() => expect(document.getElementById('email-error')!.textContent).toBe(''));
    expect(sent.map((request) => request.fields)).toEqual(['email', 'email']);
    expect(sent.some((request) => request.body.includes('hunter2'))).toBe(false);
    stop();
  });

  it("loads a page's messages in its locale, falling back where the server says (fallbackLocale)", async () => {
    const calls: unknown[][] = [];
    const messages: PageMessages<string> = { fallback: 'en', load: async (...args) => (calls.push(args), 'catalog') };
    expect(await loadPageMessages(page('users/Show', '/users/1', {}, { locale: 'fr', fallbackLocale: 'de' }), messages)).toBe('catalog');
    await loadPageMessages(page('users/Show', '/users/1', {}), messages); // a server without i18n: the loader's own fallback
    expect(calls).toEqual([['fr', { fallback: 'de' }], ['en']]);
    expect(await loadPageMessages(page('users/Show', '/users/1', {}), undefined)).toBeUndefined();
  });
});

// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1" }
/**
 * The adapter contract is real: a complete "UI adapter" in a dozen lines of plain DOM — it renders a page as its
 * component name and props in text — drives the client core through a visit, Back/Forward, deferred props, a partial
 * reload and a 409, with no UI framework anywhere. A Vue (or Svelte, or Solid) adapter is this plus components.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCATION_HEADER,
  PAGE_HEADER,
  PAGE_SCRIPT_ID,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  type PageObject,
} from '../page.ts';
import { firstErrors, hasServerMarkup, isHistoryState, Navigator, PROGRESS_ATTRIBUTE, readInitialPage, rootElement, showProgress, visitUrlOf } from './index.ts';

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
});

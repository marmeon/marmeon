// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1" }
/**
 * The in-page bar (W7 step 9) on a UI adapter in plain DOM (the pattern of `http/src/client/adapter.test.ts`): no UI framework
 * anywhere — the client core, a dozen lines that render a page as text, and the bar beside it. What it records comes from the
 * core's own requests; what it shows of the server comes from the devtools' JSON API (E131).
 */
import { devtools, islands, Navigator, type DevtoolsFeature, type DevtoolsGlobal } from '@bespokecore/http/client';
import { LOCATION_HEADER, PAGE_HEADER, REGION_HEADER, RELOAD_HEADER, type PageObject } from '@bespokecore/http/page';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevtoolsBar, SHORTCUT, STATE_KEY } from './bar.ts';
import { installDevtoolsHook } from './hook.ts';

const CANARY = 'CANARY-signed-in';
const requests: { method: string; url: string }[] = [];
const editors: string[] = [];
let ids = 0;

const page = (component: string, url: string, props: Record<string, unknown>, extra: Partial<PageObject> = {}): PageObject => ({ component, url, props, version: 'v1', ...extra });
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': `req-${++ids}`, ...headers } });

/** The server: pages with a secret prop, an island, a sign-out (409) — and the devtools' API (`/_bespoke/devtools/api/…`, `/__open-in-editor`). */
async function server(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, 'https://app.test');
  const headers = { ...(init.headers as Record<string, string>) };
  requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search });
  if (url.pathname.startsWith('/_bespoke/devtools/api/requests/')) {
    const requestId = decodeURIComponent(url.pathname.split('/').at(-1)!);
    return json({
      requestId,
      batches: ['b1'],
      entries: [
        { id: 'e1', type: 'request', at: 1, batch: 'b1', requestId, tags: [], content: { method: 'GET', url: '/users/1', path: '/users/1', route: 'users.show', routePath: '/users/:user', controller: 'ShowUserController', status: 200, durationMs: 12, inProcess: false, headers: {}, query: {}, ssr: { component: 'users/Show', durationMs: 7, complete: true }, page: { kind: 'page', component: 'users/Show', props: {}, bytes: 0, shared: ['auth'], optional: ['stats'] } } },
        { id: 'e2', type: 'query', at: 2, batch: 'b1', requestId, tags: [], content: { connection: 'default', sql: 'select * from "users" where "id" = ?', durationMs: 0.4 } },
        { id: 'e3', type: 'job', at: 3, batch: 'b2', requestId, tags: [], content: { job: 'bespoke.listener', status: 'done', durationMs: 5, attempt: 1 } },
      ],
    });
  }
  if (url.pathname === '/_bespoke/devtools/api/source') return json({ file: '/app/modules/users/controllers/ShowUserController.ts', display: 'modules/users/controllers/ShowUserController.ts', line: 7, editor: '/__open-in-editor?file=x' });
  if (url.pathname === '/__open-in-editor') return void editors.push(url.search), new Response(null, { status: 200 });
  if (url.pathname === '/logout') return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login', [RELOAD_HEADER]: 'history' } });
  if (headers[REGION_HEADER] === 'island') return json({ component: 'dashboard/Activity', props: { items: [CANARY] }, url: url.pathname, version: 'v1' }, { [PAGE_HEADER]: 'true', [REGION_HEADER]: 'island' });
  const id = /^\/users\/(\d+)$/.exec(url.pathname)?.[1];
  if (!id) return new Response('not found', { status: 404 });
  return json(page('users/Show', url.pathname + url.search, { secret: `${CANARY} ${id}`, auth: { user: 'ada' } }, { query: { tab: url.searchParams.get('tab') ?? 'links' }, queryDefaults: { tab: 'links' } }), { [PAGE_HEADER]: 'true' });
}

/** The whole adapter: a page as text, its islands as text — and the bar the dev hook attaches. */
function app() {
  let attached: { navigator: Navigator; api: DevtoolsFeature; bar: DevtoolsBar } | undefined;
  const uninstall = installDevtoolsHook(globalThis as DevtoolsGlobal, ({ navigator, api }) => {
    api.record.document(navigator.page.url, 'req-document');
    attached = { navigator, api, bar: new DevtoolsBar({ navigator, api }) };
  });
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.querySelector('#app')!;
  const initialPage = page('users/Show', '/users/1', { secret: `${CANARY} 1`, auth: { user: 'ada' }, bell: 3, activity: ['signed in'] }, {
    deferredProps: { default: ['activity'] },
    streamedProps: ['default'],
    mergeProps: ['activity'],
    onceProps: { bell: { key: 'bell' } },
    live: [{ channel: 'users.1', only: ['secret'], token: 't' }],
  });
  const navigator = new Navigator({
    initialPage,
    render: async (next) => {
      root.textContent = `${next.component} ${JSON.stringify(next.props)}`;
    },
  });
  const stop = navigator.start();
  const { api, bar } = attached!;
  const text = () => bar.root.querySelector('.bc')?.textContent ?? '';
  return { navigator, api, bar, text, stop: () => (stop(), bar.destroy(), uninstall()) };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  window.fetch = server as typeof fetch;
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  requests.length = 0;
  editors.length = 0;
  vi.restoreAllMocks();
});

describe('the dev hook (W7 step 9)', () => {
  it('attaches the bar to the navigator that takes over the history — one React threw away (a hydration error) stops recording', async () => {
    const attached: Navigator[] = [];
    const uninstall = installDevtoolsHook(globalThis as DevtoolsGlobal, ({ navigator }) => void attached.push(navigator));
    try {
      // A hydration error before any navigator started: it waits for the app's.
      (globalThis as DevtoolsGlobal).__BESPOKE_DEVTOOLS_HOOK__!.recoverable!(new Error('mismatch'), 'users/Show', false);
      const render = async () => {};
      const discarded = new Navigator({ initialPage: page('users/Show', '/users/1', {}), render });
      const app = new Navigator({ initialPage: page('users/Show', '/users/1', {}), render });
      const thrownAway = discarded.use(devtools);
      await window.fetch('/users/2', { headers: { [PAGE_HEADER]: 'true' } }); // recorded by both, before either started
      expect(thrownAway.timeline).toHaveLength(1);
      const stop = app.start();
      expect(attached).toEqual([app]);
      expect([thrownAway.timeline.length, thrownAway.hydration.length]).toEqual([0, 0]);
      expect(app.use(devtools).hydration.map((issue) => issue.message)).toEqual(['mismatch']);
      await window.fetch('/users/2', { headers: { [PAGE_HEADER]: 'true' } });
      expect(thrownAway.timeline).toHaveLength(0);
      expect(app.use(devtools).timeline).toHaveLength(2);
      stop();
    } finally {
      uninstall();
    }
  });
});

describe('the in-page bar on a plain-DOM adapter (W7 step 9, E117)', () => {
  it('attaches through the dev hook when the navigator is made: a pill at the bottom right, in a shadow root outside the app', async () => {
    const { bar, text, stop } = app();
    expect(bar.host.parentElement).toBe(document.body);
    expect(document.querySelector('#app')!.contains(bar.host)).toBe(false);
    expect(bar.root.querySelector('.pill')?.getAttribute('title')).toContain(SHORTCUT);
    expect(bar.open).toBe(false);
    expect(text()).toContain('BespokeCore');
    stop();
  });

  it('Visits: every request as it happens — kind, status, time, request id; a click shows what the server recorded (E131)', async () => {
    const { navigator, bar, text, stop } = app();
    bar.show('visits');
    await navigator.visit('/users/2');
    await navigator.reload({ only: ['secret'] });
    await navigator.use(islands).region('/islands/activity').load();
    await flush();
    const rows = [...bar.root.querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(rows[0]).toMatch(/islandGET \/islands\/activity200/);
    expect(rows[1]).toMatch(/partialGET \/users\/2200.*only secret/);
    expect(rows[2]).toMatch(/visitGET \/users\/2200.*users\/Show/);
    expect(rows.at(-1)).toMatch(/documentGET \/users\/1200/);
    // The request id leads to the server's record of it.
    (bar.root.querySelector('tbody tr:nth-child(2) button.link') as HTMLButtonElement).click();
    await flush();
    expect(bar.tab).toBe('server');
    expect(requests.some((request) => request.url.startsWith('/_bespoke/devtools/api/requests/req-'))).toBe(true);
    expect(text()).toContain('select * from "users" where "id" = ?');
    expect(text()).toContain('Jobs (1)');
    expect(text()).toContain('ShowUserController');
    stop();
  });

  it('Page: component, route, controller and view to open in the editor, the query raw and parsed, every prop with its size and badges', async () => {
    const { bar, text, stop } = app();
    bar.show('page');
    await flush();
    expect(text()).toContain('Page: users/Show');
    expect(text()).toContain('controller ShowUserController');
    expect(text()).toContain('GET /users/:user');
    const row = (key: string) => [...bar.root.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent?.startsWith(key))?.textContent ?? '';
    expect(row('activity')).toMatch(/deferred.*streamed.*merged/);
    expect(row('bell')).toMatch(/once/);
    expect(row('secret')).toMatch(/live/);
    expect(row('auth')).toMatch(/shared/);
    expect(row('stats')).toMatch(/not sent.*optional/);
    expect(row('secret')).toMatch(/\d+ B$/);
    // "Open in editor": the controller's file from the API, then Vite's /__open-in-editor.
    const open = [...bar.root.querySelectorAll('button')].filter((button) => button.textContent === 'open in editor');
    expect(open).toHaveLength(2);
    open[1]!.click();
    await flush();
    expect(requests.map((request) => request.url)).toContain('/_bespoke/devtools/api/source?controller=ShowUserController');
    expect(editors).toEqual(['?file=x']);
    expect(text()).toContain('opened modules/users/controllers/ShowUserController.ts');
    stop();
  });

  it('Layers & regions and SSR: the islands on screen with their status; hydration errors the React adapter reports', async () => {
    const { navigator, bar, text, stop } = app();
    const region = navigator.use(islands).region('/islands/activity');
    bar.show('layers');
    expect(text()).toContain('/islands/activity');
    expect(text()).toContain('loading');
    await region.load();
    await flush();
    expect(text()).toContain('ready');
    expect(text()).toContain('dashboard/Activity');
    (globalThis as DevtoolsGlobal).__BESPOKE_DEVTOOLS_HOOK__!.recoverable!(new Error('Hydration failed because the server rendered text didn’t match the client.'), 'users/Show', false);
    bar.show('ssr');
    await flush();
    expect(text()).toContain('Mismatch in users/Show: Hydration failed');
    expect(text()).toContain('users/Show: 7 ms');
    expect(bar.root.querySelector('.dot')?.className).toContain('bad');
    stop();
  });

  it('keeps only whether it is open and which tab in sessionStorage — never a prop, nowhere (E36)', async () => {
    const { navigator, bar, stop } = app();
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, shiftKey: true, code: 'KeyD' }));
    expect(bar.open).toBe(true);
    await navigator.visit('/users/2?tab=about');
    bar.show('page'); // the panel's state is stored while the page on screen holds the canary
    await flush();
    expect(JSON.parse(window.sessionStorage.getItem(STATE_KEY)!)).toEqual({ open: true, tab: 'page' });
    const stored = [...Object.entries(window.sessionStorage), ...Object.entries(window.localStorage), JSON.stringify(window.history.state)].join('\n');
    expect(stored).not.toContain(CANARY);
    // A new document opens the panel where it was — the state, not the data.
    stop();
    const again = app();
    expect([again.bar.open, again.bar.tab]).toEqual([true, 'page']);
    again.stop();
  });

  it('after signing out (a 409) it shows nothing of the old page — not in its DOM, not in what it keeps (E36)', async () => {
    const loads: string[] = [];
    vi.spyOn(window.location, 'assign').mockImplementation((url) => void loads.push(String(url)));
    const { navigator, api, bar, text, stop } = app();
    bar.show('page');
    await navigator.use(islands).region('/islands/activity').load();
    await flush();
    expect(text()).toContain(CANARY); // the props it shows on screen…
    bar.show('visits');
    await navigator.visit('/logout', { method: 'post' });
    await flush();
    expect(loads).toEqual(['/login']);
    for (const tab of ['visits', 'page', 'layers', 'optimistic', 'server', 'ssr'] as const) {
      bar.show(tab);
      expect(text(), tab).not.toContain(CANARY);
      expect(text(), tab).toContain('being left');
    }
    expect(JSON.stringify([api.timeline, api.snapshots, api.hydration, [...api.cache]])).not.toContain(CANARY);
    stop();
  });
});

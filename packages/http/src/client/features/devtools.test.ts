import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_HEADER, LOCATION_HEADER, PAGE_HEADER, REGION_HEADER, RELOAD_HEADER, VALIDATE_HEADER, type PageObject } from '../../page.ts';
import { boot, FakeWindow, ORIGIN, page, settle, withActions, type FakeEventSource } from '../test-window.ts';
import { devtools, devtoolsReports, type DevtoolsFeature, type DevtoolsGlobal, type TimelineEntry } from './devtools.ts';
import { islands } from './islands.ts';
import { prefetch } from './prefetch.ts';

/**
 * The devtools' data feature (W7 step 9): what the in-page bar shows, recorded UI-free — every request of the client core with its
 * kind, status, duration and the server's request id (E131), live hints, optimistic patches, hydration errors — in slots of the
 * document only: gone when the document is left (E36).
 */

const CANARY = 'CANARY-signed-in';
let ids = 0;
/** A page answer as the server sends it — with its request id (`x-request-id`, E131). */
const answer = (body: object, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { [PAGE_HEADER]: 'true', 'content-type': 'application/json', 'x-request-id': `req-${++ids}`, ...init.headers } });
const pending = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));

/** The server: pages with a secret, `/slow` that never answers, a layer, an island, an action that is refused (422), a 409. */
function server(win: FakeWindow) {
  win.handler = (url, init) => {
    const { pathname } = new URL(url);
    const headers = { ...(init.headers as Record<string, string>) };
    if (pathname === '/slow') return pending(init);
    if (pathname === '/like') return new Response(JSON.stringify({ message: 'Invalid', errors: { note: [`${CANARY} is too long`] } }), { status: 422, headers: { 'content-type': 'application/json', 'x-request-id': `req-${++ids}` } });
    if (pathname === '/register' && headers[VALIDATE_HEADER]) return new Response(JSON.stringify({ errors: { email: ['taken'] } }), { status: 422, headers: { 'content-type': 'application/json' } });
    if (pathname === '/logout') return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login', [RELOAD_HEADER]: 'history' } });
    if (pathname === '/deploy') return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/deploy', [RELOAD_HEADER]: 'version' } });
    if (headers[REGION_HEADER] === 'island') return answer({ component: 'dashboard/Activity', props: { items: [CANARY] }, url: pathname, version: null }, { headers: { [REGION_HEADER]: 'island' } });
    if (pathname === '/users/1/edit') return answer({ ...page(pathname, { secret: CANARY }, 'users/Edit'), layer: { key: 'edit', base: '/users/1' } });
    if (pathname === '/deferring') return answer({ ...page(pathname, { secret: CANARY }, 'pages/Deferring'), deferredProps: { default: ['later'] } });
    return answer(page(pathname, { secret: `${CANARY} ${pathname}` }, 'users/Show'));
  };
}

function tab(initial: PageObject = page('/users/1', { secret: CANARY }, 'users/Show')) {
  const win = new FakeWindow(`${ORIGIN}${initial.url}`);
  server(win);
  const booted = boot(win, initial);
  const api = booted.navigator.use(devtools);
  return { win, api, ...booted };
}

const kinds = (api: DevtoolsFeature) => api.timeline.map((entry) => `${entry.kind} ${entry.method} ${entry.url} ${entry.status ?? '-'} ${entry.outcome ?? 'under way'}`);
const last = (api: DevtoolsFeature): TimelineEntry => api.timeline.at(-1)!;
const holds = (api: DevtoolsFeature) => JSON.stringify([api.timeline, api.snapshots, api.hydration, [...api.cache]]).includes(CANARY);

afterEach(() => {
  delete (globalThis as DevtoolsGlobal).__MARMEON_DEVTOOLS_HOOK__;
});

describe('the devtools data feature — every request of the client core, by kind (W7 step 9)', () => {
  it('visits, reloads, partial reloads, background visits, deferred props, prefetches — with status, request id and view', async () => {
    const { api, navigator } = tab();
    await navigator.visit('/users/2');
    expect(last(api)).toMatchObject({ kind: 'visit', method: 'GET', url: '/users/2', status: 200, outcome: 'ok', component: 'users/Show', answered: '/users/2' });
    expect(last(api).requestId).toMatch(/^req-\d+$/);
    expect(last(api).end! - last(api).at).toBeGreaterThanOrEqual(0);
    await navigator.reload();
    await navigator.reload({ only: ['secret'] });
    await navigator.reload({ async: true });
    await navigator.visit('/deferring');
    await settle();
    await navigator.use(prefetch).prefetch('/users/3');
    await navigator.visit('/users/3');
    expect(kinds(api)).toEqual([
      'visit GET /users/2 200 ok',
      'reload GET /users/2 200 ok',
      'partial GET /users/2 200 ok',
      'background GET /users/2 200 ok',
      'visit GET /deferring 200 ok',
      'deferred GET /deferring 200 ok',
      'prefetch GET /users/3 200 ok',
      'visit GET /users/3 - prefetched', // it took the page fetched ahead: no request of its own
    ]);
    expect(api.timeline[2]).toMatchObject({ only: ['secret'] });
    expect(api.timeline[5]).toMatchObject({ only: ['later'] });
  });

  it('layers, islands, actions (422 with its errors), live validations, live hints and cancelled visits', async () => {
    const { api, navigator, win } = tab();
    await navigator.visit('/users/1/edit', { layer: true });
    expect(last(api)).toMatchObject({ kind: 'layer', component: 'users/Edit', outcome: 'ok' });
    await navigator.use(islands).region('/islands/activity').load();
    expect(last(api)).toMatchObject({ kind: 'island', component: 'dashboard/Activity', status: 200 });
    const outcome = await withActions(navigator).action('/like', { data: { note: 'x' }, name: 'like' });
    expect(outcome.ok).toBe(false);
    await settle();
    expect(last(api)).toMatchObject({ kind: 'action', method: 'POST', status: 422, outcome: 'invalid', errors: { note: [`${CANARY} is too long`] } });
    await win.fetch('/register', { method: 'POST', headers: { [VALIDATE_HEADER]: 'email' } });
    await settle();
    expect(last(api)).toMatchObject({ kind: 'validation', status: 422, outcome: 'invalid', errors: { email: ['taken'] } });
    // A hint on the live stream (W6.10) — no request of its own.
    const stream = new win.EventSource!(`/_marmeon/live?c=${CANARY}.users.1`) as unknown as FakeEventSource;
    stream.emit('refresh', { channel: 'users.1', only: ['secret'], seq: 2 });
    expect(last(api)).toMatchObject({ kind: 'live', method: 'SSE', url: '/_marmeon/live', channel: 'users.1', hinted: ['secret'] }); // not the signed channels
    // A newer visit cancels the one under way.
    const slow = navigator.visit('/slow');
    await navigator.visit('/users/2');
    await slow;
    expect(api.timeline.find((entry) => entry.url === '/slow')).toMatchObject({ kind: 'visit', outcome: 'cancelled' });
    // Requests that are none of the core's are not shown — an app's own fetch, the bar's own.
    const before = api.timeline.length;
    await win.fetch('/api/anything');
    expect(api.timeline.length).toBe(before);
    expect(win.requests.some((request) => request.headers[ACTION_HEADER] === 'true')).toBe(true);
  });

  it('a postponed new build (409 version, kept): its request shows the reload and why — the document stays', async () => {
    const { api, navigator } = tab();
    navigator.on('version', (event) => event.preventDefault());
    await navigator.reload({ async: true, only: ['secret'], data: {} });
    await navigator.visit('/deploy', { async: true });
    expect(last(api)).toMatchObject({ status: 409, outcome: 'reload', location: '/deploy', reload: 'version' });
    expect(api.left).toBe(false);
  });

  it('the document with the status it came with — a 404 page is a 404 (navigation timing), 200 where the browser does not say (W7.11)', () => {
    const { api } = tab();
    const spy = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ responseStatus: 404 } as unknown as PerformanceEntry]);
    try {
      api.record.document('/gibt-es-nicht', 'req-404');
    } finally {
      spy.mockRestore();
    }
    expect(api.timeline[0]).toMatchObject({ kind: 'document', status: 404, requestId: 'req-404' });
    api.record.document('/users/1', undefined);
    expect(api.timeline[0]).toMatchObject({ kind: 'document', status: 200 });
  });

  it('answerFor: the answer that showed a page — the latest with every prop, its request id the server’s record of it (E131)', async () => {
    const { api, navigator } = tab();
    api.record.document('/users/1', 'req-document');
    expect(api.answerFor('/users/1')).toMatchObject({ kind: 'document', requestId: 'req-document' });
    await navigator.visit('/users/2');
    const visit = last(api);
    await navigator.reload({ only: ['secret'] });
    expect(api.answerFor('/users/2')).toBe(visit); // not the partial reload's
    expect(api.answerFor('/nowhere')).toBeUndefined();
  });
});

describe('what only the dev hook sees — optimistic patches and hydration errors', () => {
  it('a patch: the props it changed, before and as shown, with the action it went with — and how it ended', async () => {
    const { api, navigator } = tab();
    (globalThis as DevtoolsGlobal).__MARMEON_DEVTOOLS_HOOK__ = devtoolsReports(() => api);
    const actions = withActions(navigator);
    await actions.action('/like', { optimistic: actions.optimistic(() => ({ liked: true, secret: 'patched' })) });
    await settle();
    const action = last(api);
    expect(action).toMatchObject({ kind: 'action', status: 422 });
    expect(api.snapshots).toEqual([
      { id: action.patches![0], request: action.id, at: expect.any(Number), before: { liked: undefined, secret: CANARY }, after: { liked: true, secret: 'patched' }, state: 'removed' },
    ]);
  });

  it('a hydration error React recovered from — with the page it happened on', () => {
    const { api } = tab();
    api.record.recoverable(new Error(`Text content does not match: "${CANARY}"`), 'users/Show', false);
    expect(api.hydration).toEqual([{ at: expect.any(Number), component: 'users/Show', server: false, message: `Text content does not match: "${CANARY}"`, stack: expect.any(String) }]);
  });

  it('reports before the bar attached wait for it (a hydration error while the first page hydrates)', () => {
    let current: DevtoolsFeature | undefined;
    const reports = devtoolsReports(() => current);
    reports.recoverable(new Error('mismatch'), 'users/Show', false);
    const { api } = tab();
    current = api;
    reports.flush();
    expect(api.hydration.map((issue) => issue.message)).toEqual(['mismatch']);
  });
});

describe('the document is left (E36): nothing of it stays — in no slot, not in the feature’s lists', () => {
  it('signed out (a 409): timeline, patches, hydration errors and the bar’s cache are empty, `left` says so, listeners hear it', async () => {
    const { api, navigator, win } = tab();
    (globalThis as DevtoolsGlobal).__MARMEON_DEVTOOLS_HOOK__ = devtoolsReports(() => api);
    const actions = withActions(navigator);
    await navigator.visit('/users/1/edit', { layer: true });
    await actions.action('/like', { optimistic: actions.optimistic(() => ({ liked: CANARY })) });
    api.record.recoverable(new Error(CANARY), 'users/Show', true);
    api.cache.set('request:req-1', { state: 'done', value: { entries: [CANARY] } });
    await settle();
    expect(holds(api)).toBe(true);
    let heard = 0;
    api.subscribe(() => heard++);
    // What someone took before (the bar while it drew): emptied too — not only forgotten.
    const taken = [api.timeline, api.snapshots, api.hydration, api.cache] as const;
    await navigator.visit('/logout', { method: 'post' });
    await settle();
    expect(win.loads).toEqual(['assign /login']);
    expect(api.left).toBe(true);
    expect([api.timeline.length, api.snapshots.length, api.hydration.length, api.cache.size]).toEqual([0, 0, 0, 0]);
    expect([taken[0].length, taken[1].length, taken[2].length, taken[3].size]).toEqual([0, 0, 0, 0]);
    expect(holds(api)).toBe(false);
    expect(heard).toBeGreaterThan(0);
    // What still arrives (a request of the old document) lands nowhere.
    api.record.recoverable(new Error(CANARY), 'users/Show', true);
    expect(holds(api)).toBe(false);
  });
});

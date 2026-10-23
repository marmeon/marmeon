import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_HEADER, REGION_HEADER, type LiveSubscription, type PageObject, type RegionObject, PROTOCOL_VERSION } from '../protocol.ts';
import type { Feature } from './feature.ts';
import { actions } from './features/actions.ts';
import { guard } from './features/guard.ts';
import { islands } from './features/islands.ts';
import { layers } from './features/layers.ts';
import { live, LIVE_MAX_WAIT, LIVE_QUIET } from './features/live.ts';
import { tabSync } from './features/tab-sync.ts';
import { Navigator } from './navigation.ts';
import { SESSION_PATH } from '../tab-sync-protocol.ts';
import { boot, FakeChannels, FakeWindow, ORIGIN, page, pageResponse, settle } from './test-window.ts';

/** A subscription as the server signs it into a page — the token is opaque to the client. */
const follows = (channel: string, only?: string[]): LiveSubscription => ({ channel, ...(only ? { only } : {}), token: `t-${channel.replaceAll('.', '_')}` });
const livePage = (url: string, live: LiveSubscription[], props: Record<string, unknown> = { profile: 'v1' }, component = 'users/Show'): PageObject => ({ ...page(url, props, component), live });
const islandResponse = (body: RegionObject) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [REGION_HEADER]: 'island', 'content-type': 'application/json' } });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Until the feature's chunk is there and it looked at the screen (it syncs 10 ms after a change). */
async function arrived(win: FakeWindow, sources = 1) {
  for (let i = 0; i < 50 && win.sources.length < sources; i++) await wait(5);
  await wait(20);
}

/** The partial reloads a tab sent: their URL and `only`. */
const reloads = (win: FakeWindow) => win.requests.filter((request) => request.headers['x-marmeon-partial-data'] !== undefined).map((request) => `${new URL(request.url).pathname} ${request.headers['x-marmeon-partial-data']}`);

/** A signed-in tab on Ada's profile, which follows `users.1` (only its profile) and — shared, the layout's bell — `notifications.user.1`. */
async function tab({ protocol = 'h2', features = [] as readonly Feature[] } = {}) {
  const win = new FakeWindow(`${ORIGIN}/users/1`);
  win.protocol = protocol;
  win.handler = (url) => pageResponse(livePage(new URL(url).pathname, [follows('notifications.user.1', ['bell']), follows('users.1', ['profile'])], { profile: 'v2', bell: 1 }));
  const initial = livePage('/users/1', [follows('notifications.user.1', ['bell']), follows('users.1', ['profile'])], { profile: 'v1', bell: 0 });
  const booted = boot(win, initial, { features });
  await arrived(win);
  return { win, ...booted };
}

afterEach(async () => {
  await wait(1);
});

describe('live props in the client core — server-driven, one stream per document', () => {
  it('the core loads the feature when a page follows a channel — and opens ONE stream for every channel on screen', async () => {
    const { win, navigator } = await tab();
    expect(win.sources).toHaveLength(1);
    const source = win.source!;
    const url = new URL(source.url, ORIGIN);
    expect(url.pathname).toBe('/_marmeon/live');
    expect(url.searchParams.get('connection')).toMatch(/^[0-9a-f]{24}$/);
    expect(url.searchParams.getAll('c')).toEqual(['t-notifications_user_1.notifications.user.1', 't-users_1.users.1']);
    // An island that follows a channel of its own joins the same stream (one connection: the old one closes).
    win.handler = () => islandResponse({ component: 'dashboard/SignIns', props: { entries: [] }, url: '/islands/sign-ins', version: null, live: [follows('dashboard.sign-ins')] });
    await navigator.use(islands).region('/islands/sign-ins').load();
    await arrived(win, 2);
    expect(win.sources).toHaveLength(2);
    expect(win.sources[0]!.closed).toBe(true);
    expect(win.source!.channels).toEqual(['dashboard.sign-ins', 'notifications.user.1', 'users.1']);
  });

  it('a page that follows nothing loads nothing and opens no stream', async () => {
    const win = new FakeWindow(`${ORIGIN}/about`);
    boot(win, page('/about'), { features: [] });
    await wait(40);
    expect(win.sources).toEqual([]);
  });

  it('every request of the tab names its document (x-marmeon-connection) — visits and actions', async () => {
    const { win, navigator } = await tab();
    const connection = new URL(win.source!.url, ORIGIN).searchParams.get('connection');
    await navigator.visit('/users/1/links', { method: 'post', data: { url: 'https://x.test' } });
    expect(win.requests.at(-1)!.headers['x-marmeon-connection']).toBe(connection);
    win.handler = () => Response.json({ ok: true });
    await navigator.use(actions).run('/notifications/1/read', { method: 'post' });
    expect(win.requests.at(-1)!.headers['x-marmeon-connection']).toBe(connection);
  });

  it('a hint reloads what follows its channel — only the props its subscription names of those the hint names', async () => {
    const { win } = await tab();
    win.source!.emit('hello', { seq: { 'users.1': 0, 'notifications.user.1': 0 } });
    win.source!.emit('refresh', { channel: 'users.1', only: ['profile', 'links'], seq: 1 });
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toEqual(['/users/1 profile']);
    // A hint without props: what the subscription names (the bell).
    win.source!.emit('refresh', { channel: 'notifications.user.1', only: null, seq: 1 });
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toEqual(['/users/1 profile', '/users/1 bell']);
    // A hint that names nothing the page follows: no reload.
    win.source!.emit('refresh', { channel: 'users.1', only: ['avatar'], seq: 2 });
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toHaveLength(2);
  });

  it('an island and a layer reload themselves — once per burst, each its own props', async () => {
    const { win, navigator } = await tab({ features: [layers] });
    win.handler = (url) => {
      const { pathname } = new URL(url);
      if (pathname === '/islands/sign-ins') return islandResponse({ component: 'dashboard/SignIns', props: { entries: [] }, url: pathname, version: null, live: [follows('dashboard.sign-ins')] });
      if (pathname === '/users/1/edit') return pageResponse({ ...livePage(pathname, [follows('users.1', ['name'])], { name: 'Ada' }, 'users/Edit'), layer: { key: 'edit', base: '/users/1' } });
      return pageResponse(livePage(pathname, [], { profile: 'v2' }));
    };
    await navigator.use(islands).region('/islands/sign-ins').load();
    await navigator.visit('/users/1/edit', { layer: true });
    await arrived(win, 3);
    expect(win.source!.channels).toEqual(['dashboard.sign-ins', 'notifications.user.1', 'users.1']);
    win.source!.emit('hello', { seq: { 'dashboard.sign-ins': 0, 'notifications.user.1': 0, 'users.1': 0 } });
    const before = win.requests.length;
    win.source!.emit('refresh', { channel: 'dashboard.sign-ins', only: null, seq: 1 });
    win.source!.emit('refresh', { channel: 'dashboard.sign-ins', only: null, seq: 2 });
    win.source!.emit('refresh', { channel: 'users.1', only: ['profile', 'name'], seq: 1 });
    await wait(LIVE_QUIET + 50);
    const sent = win.requests.slice(before).map((request) => `${new URL(request.url).pathname} ${request.headers[REGION_HEADER] ?? 'page'} ${request.headers['x-marmeon-partial-data'] ?? 'all'}`);
    expect(sent.sort()).toEqual(['/islands/sign-ins island all', '/users/1 page profile', '/users/1/edit layer name']);
  });

  it('the tab that caused a change does not reload for it (the server sends it `only: []`)', async () => {
    const { win } = await tab();
    win.source!.emit('hello', { seq: { 'users.1': 0 } });
    win.source!.emit('refresh', { channel: 'users.1', only: [], seq: 1 });
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toEqual([]);
  });

  it('20 hints in one second: ONE partial reload, the union of what they name', async () => {
    const { win } = await tab();
    win.source!.emit('hello', { seq: { 'users.1': 0, 'notifications.user.1': 0 } });
    for (let i = 1; i <= 20; i++) {
      win.source!.emit('refresh', i % 2 ? { channel: 'users.1', only: ['profile'], seq: i } : { channel: 'notifications.user.1', only: null, seq: i });
      await wait(40);
    }
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toEqual(['/users/1 bell,profile']);
  });

  it('a hint waits at most 2 s: a burst that never pauses still reloads (once per 2 s, not per hint)', async () => {
    const { win } = await tab();
    // The clock moves by hand from here: the burst lasts LIVE_MAX_WAIT + 400 ms of the feature's time, not of the test's.
    vi.useFakeTimers();
    try {
      win.source!.emit('hello', { seq: { 'users.1': 0 } });
      const started = Date.now();
      for (let i = 1; Date.now() - started < LIVE_MAX_WAIT + 400; i++) {
        win.source!.emit('refresh', { channel: 'users.1', only: ['profile'], seq: i });
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(reloads(win)).toEqual(['/users/1 profile']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsaved changes on screen (a guard holds): no reload — "updates available" until apply()', async () => {
    const { win, navigator } = await tab({ features: [guard] });
    const updates = navigator.use(live).updates;
    let told = 0;
    updates.subscribe(() => told++);
    const lift = navigator.use(guard).add({ message: 'Unsaved' });
    win.source!.emit('hello', { seq: { 'users.1': 0 } });
    win.source!.emit('refresh', { channel: 'users.1', only: ['profile'], seq: 1 });
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toEqual([]);
    expect([updates.pending, told]).toEqual([true, 1]);
    updates.apply();
    await settle();
    expect(reloads(win)).toEqual(['/users/1 profile']);
    expect([updates.pending, told]).toEqual([false, 2]);
    lift();
  });

  it('another page follows other channels: the stream switches — one connection at a time', async () => {
    const { win, navigator } = await tab();
    win.handler = () => pageResponse(livePage('/dashboard', [follows('notifications.user.1', ['bell'])], {}, 'dashboard/Show'));
    await navigator.visit('/dashboard');
    await arrived(win, 2);
    expect(win.sources.map((source) => source.closed)).toEqual([true, false]);
    expect(win.source!.channels).toEqual(['notifications.user.1']);
    // A page that follows nothing: no stream.
    win.handler = () => pageResponse(page('/about'));
    await navigator.visit('/about');
    await wait(30);
    expect(win.source).toBeUndefined();
  });

  it('the server ended the stream (signed out elsewhere): no reconnect, also when the tab comes back', async () => {
    const { win } = await tab();
    win.source!.emit('hello', { seq: {} });
    win.sources[0]!.emit('end', {});
    win.hide();
    win.show();
    win.resume();
    await wait(30);
    expect(win.sources).toHaveLength(1);
    expect(win.sources[0]!.closed).toBe(true);
  });
});

describe('the connection rule: always connected — over HTTP/1.1 only while visible', () => {
  for (const protocol of ['http/1.1', ''] as const) {
    it(`over ${protocol || 'an unknown protocol'}: a hidden tab has no open stream, a visible one connects again`, async () => {
      const { win } = await tab({ protocol });
      expect(win.source).toBeDefined();
      win.hide();
      expect(win.source).toBeUndefined();
      await wait(30);
      expect(win.sources).toHaveLength(1);
      win.show();
      expect(win.sources).toHaveLength(2);
      expect(win.source).toBeDefined();
    });
  }

  it('over h2: the stream stays open in a hidden tab', async () => {
    const { win } = await tab({ protocol: 'h2' });
    win.hide();
    await wait(30);
    expect(win.sources).toHaveLength(1);
    expect(win.source).toBeDefined();
    win.show();
    expect(win.sources).toHaveLength(1);
  });

  it('a page loaded in a hidden tab over HTTP/1.1 connects once it is shown', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.protocol = 'http/1.1';
    win.visibilityState = 'hidden';
    boot(win, livePage('/users/1', [follows('users.1')]), { features: [] });
    await wait(40);
    expect(win.sources).toEqual([]);
    win.show();
    expect(win.sources).toHaveLength(1);
  });
});

describe('catching up: a stream that was away reloads once what it missed', () => {
  it('hidden over HTTP/1.1 while two hints passed (both channels of the page): back, hello says so — exactly ONE reload, the union', async () => {
    const { win } = await tab({ protocol: 'http/1.1' });
    win.source!.emit('hello', { seq: { 'users.1': 3, 'notifications.user.1': 7 } });
    win.hide();
    win.show();
    win.source!.emit('hello', { seq: { 'users.1': 4, 'notifications.user.1': 8 } });
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toEqual(['/users/1 bell,profile']);
  });

  it('nothing missed — no reload', async () => {
    const { win } = await tab({ protocol: 'http/1.1' });
    win.source!.emit('hello', { seq: { 'users.1': 3, 'notifications.user.1': 7 } });
    win.hide();
    win.show();
    win.source!.emit('hello', { seq: { 'users.1': 3, 'notifications.user.1': 7 } });
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toEqual([]);
  });

  it('a broken connection (the browser reconnects the same stream): hello after it — one reload of what moved', async () => {
    const { win } = await tab();
    win.source!.emit('hello', { seq: { 'users.1': 1, 'notifications.user.1': 1 } });
    win.source!.fail();
    win.source!.emit('hello', { seq: { 'users.1': 2, 'notifications.user.1': 1 } });
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toEqual(['/users/1 profile']);
  });

  it('a stream that broke before its hello: whatever the next hello says is news — one reload of what it follows', async () => {
    const { win } = await tab();
    win.source!.fail();
    win.source!.emit('hello', { seq: { 'users.1': 5, 'notifications.user.1': 0 } });
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toEqual(['/users/1 bell,profile']);
  });

  it('a frozen tab that resumes with its stream gone (refused or closed): it connects again and catches up', async () => {
    const { win } = await tab();
    win.source!.emit('hello', { seq: { 'users.1': 1, 'notifications.user.1': 1 } });
    win.source!.fail(true);
    expect(win.source).toBeUndefined();
    win.resume();
    expect(win.sources).toHaveLength(2);
    win.source!.emit('hello', { seq: { 'users.1': 1, 'notifications.user.1': 2 } });
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toEqual(['/users/1 bell']);
  });
});

describe('live and the session of the tab', () => {
  /** A tab with tab sync on Ada's profile (it follows users.1) in a browser whose session the test changes; its tokens are the epoch's. */
  async function syncedTab({ confirm }: { confirm?: () => Promise<boolean> } = {}) {
    const channels = new FakeChannels();
    const server = { epoch: 'e1' };
    const win = new FakeWindow(`${ORIGIN}/users/1`, channels);
    const signed = () => [{ channel: 'users.1', only: ['profile'], token: `t-${server.epoch}` }];
    win.handler = (url) => (new URL(url).pathname === SESSION_PATH ? Response.json({ epoch: server.epoch }) : pageResponse({ ...livePage('/users/1', signed(), { profile: 'v2' }), epoch: server.epoch }));
    const booted = boot(win, { ...livePage('/users/1', signed()), epoch: 'e1' }, { features: [tabSync, guard], ...(confirm ? { confirm } : {}) });
    await arrived(win);
    return { win, channels, server, ...booted };
  }

  it('pauses while the tab-sync question is open: the stream closes, no reconnect, no reload — a page of the new session connects again', async () => {
    const questions: unknown[] = [];
    // The user has not answered yet: the app's dialog is open.
    const { win, channels, server, navigator } = await syncedTab({ confirm: (request?: unknown) => (questions.push(request), new Promise(() => {})) as never });
    const first = win.source!;
    first.emit('hello', { seq: { 'users.1': 0 } });
    navigator.use(guard).add({ message: 'Unsaved' });
    // A hint waits for the unsaved changes.
    first.emit('refresh', { channel: 'users.1', only: ['profile'], seq: 1 });
    await wait(LIVE_QUIET + 50);
    expect(navigator.use(live).updates.pending).toBe(true);
    // Another tab signed out (and in as someone else): this tab hears it, asks the server — and the user.
    server.epoch = 'e2';
    channels.inject({ v: 1, epoch: 'e2' });
    for (let i = 0; i < 6; i++) await settle();
    expect(questions).toHaveLength(1);
    expect(first.closed).toBe(true);
    // Visible again, resumed: still no stream (its tokens are the old session's).
    win.hide();
    win.show();
    win.resume();
    await wait(40);
    expect(win.sources).toHaveLength(1);
    // What waited is not reloaded under the new session — not even when asked to.
    navigator.use(live).updates.apply();
    await wait(LIVE_QUIET + 50);
    expect(reloads(win)).toEqual([]);
    // A page of the new session lands (the user saved and moved on): live follows it again — with the new session's token.
    await navigator.reload({ only: ['profile'] });
    await arrived(win, 2);
    expect(win.sources).toHaveLength(2);
    expect(win.source!.url).toContain('c=t-e2.users.1');
  });

  it('a second navigator (React builds one after a hydration mismatch) opens no stream; stop() lets go of every listener and the stream', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`, new FakeChannels());
    win.handler = () => pageResponse(livePage('/users/1', [follows('users.1', ['profile'])]));
    const initial = { ...livePage('/users/1', [follows('users.1', ['profile'])]), epoch: 'e1' };
    // The first navigator: its features attached (tab sync, live once its chunk is there), never started — the tree was thrown away.
    // It neither streams nor listens.
    new Navigator({ initialPage: initial, window: win, render: async () => {}, features: [tabSync] });
    const { stop } = boot(win, initial, { features: [tabSync] });
    await arrived(win);
    await wait(40);
    expect(win.sources.filter((source) => !source.closed)).toHaveLength(1);
    expect([win.listening('document:visibilitychange'), win.listening('document:resume'), win.listening('window:pageshow')]).toEqual([2, 1, 3]);
    stop();
    expect([win.listening('document:visibilitychange'), win.listening('document:resume'), win.listening('window:pageshow')]).toEqual([0, 0, 0]);
    expect(win.sources.every((source) => source.closed)).toBe(true);
    win.hide();
    win.show();
    await wait(40);
    expect(win.sources.filter((source) => !source.closed)).toHaveLength(0);
  });
});

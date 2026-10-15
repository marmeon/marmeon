import { describe, expect, it } from 'vitest';
import type { PageObject } from '../../page.ts';
import { DOCUMENT_HEADER, SESSION_PATH } from '../../tab-sync-protocol.ts';
import type { Feature } from '../feature.ts';
import { guard } from './guard.ts';
import { prefetch } from './prefetch.ts';
import { remember } from './remember.ts';
import { DEFAULT_SESSION_CHANGED_MESSAGE, isTabSyncMessage, tabSync, type EpochChange } from './tab-sync.ts';
import { boot, FakeChannels, FakeWindow, ORIGIN, page, pageResponse, settle } from '../test-window.ts';
import { loadSensitiveFields } from '../remember.ts';

// The rules that tell sensitive fields load on first use; these tests write and read at once.
await loadSensitiveFields();

/**
 * Tab sync: tabs of one browser — a `FakeWindow` each — share the browser's channels (`FakeChannels`) and
 * one server, whose epoch the test changes (someone signed out). What each tab does is its own navigator's, as in the browser.
 */

const SECRET = 'SECRET-of-ada';

function browser(epoch = 'e1') {
  const channels = new FakeChannels();
  const server = { epoch };
  const tab = (url: string, { features = [tabSync, prefetch, remember, guard], secret = true }: { features?: readonly Feature[]; secret?: boolean } = {}) => {
    const win = new FakeWindow(`${ORIGIN}${url}`, channels);
    win.handler = (to) => {
      const { pathname } = new URL(to);
      if (pathname === SESSION_PATH) return Response.json({ epoch: server.epoch });
      return pageResponse({ ...page(pathname, secret ? { secret: `${SECRET} ${pathname}` } : {}), epoch: server.epoch });
    };
    const initial: PageObject = { ...page(url, secret ? { secret: `${SECRET} ${url}` } : {}), epoch: server.epoch };
    return { win, ...boot(win, initial, { features }) };
  };
  return { channels, server, tab };
}

/** Messages on their way, questions to the server, a reload: all done. */
const quiet = async () => {
  for (let i = 0; i < 6; i++) await settle();
};

const sessionQuestions = (win: FakeWindow) => win.requests.filter((request) => new URL(request.url).pathname === SESSION_PATH);

describe('tab sync — navigator.use(tabSync)', () => {
  it('posts its epoch when it starts: exactly { v: 1, epoch } — nothing of the page, no id, no token', async () => {
    const { channels, tab } = browser();
    tab('/users/1');
    tab('/users/2');
    await quiet();
    expect(channels.posted).toEqual([
      { name: 'marmeon', data: { v: 1, epoch: 'e1' } },
      { name: 'marmeon', data: { v: 1, epoch: 'e1' } },
    ]);
    expect(JSON.stringify(channels.posted)).not.toContain(SECRET);
  });

  it('another tab signed out: this one hears the new epoch, asks the server, lets go of everything it keeps and loads again', async () => {
    const { server, tab } = browser();
    const b = tab('/users/1');
    await b.navigator.visit('/users/2');
    await b.navigator.use(prefetch).prefetch('/users/3');
    b.navigator.use(remember).of(b.owner().entry!).set('draft', { note: SECRET });
    // What B keeps — held from before (the core forgets its slot maps when the document is left: a later look would find new ones).
    const remembered = b.navigator.use(remember).of(b.owner().entry!);
    expect([b.navigator.cachedPages, b.navigator.use(prefetch).size, remembered.has('draft')]).toEqual([2, 1, true]);
    // Tab A signs out: the 409 loads its next page fully — a new document, which posts the new epoch when it starts.
    server.epoch = 'e2';
    tab('/login', { secret: false });
    await quiet();
    expect(sessionQuestions(b.win)).toHaveLength(1);
    expect(b.win.loads).toEqual(['reload']);
    expect([b.navigator.cachedPages, b.navigator.use(prefetch).size, remembered.has('draft')]).toEqual([0, 0, false]);
  });

  it('a frozen tab misses the message — when it becomes visible it asks the server, and loads again', async () => {
    const { server, tab } = browser();
    const b = tab('/users/1');
    b.win.frozen = true;
    b.win.hide();
    server.epoch = 'e2';
    tab('/login', { secret: false });
    await quiet();
    expect([sessionQuestions(b.win).length, b.win.loads]).toEqual([0, []]);
    b.win.frozen = false;
    b.win.show();
    await quiet();
    expect(sessionQuestions(b.win)).toHaveLength(1);
    expect(b.win.loads).toEqual(['reload']);
  });

  it('back from the back/forward cache: it asks the server', async () => {
    const { server, tab } = browser();
    const b = tab('/users/1');
    server.epoch = 'e2';
    b.win.dispatch('pageshow', { persisted: true });
    await quiet();
    expect([sessionQuestions(b.win).length, b.win.loads]).toEqual([1, ['reload']]);
  });

  it('becoming visible with nothing changed: one question, nothing else', async () => {
    const { tab } = browser();
    const b = tab('/users/1');
    b.win.hide();
    b.win.show();
    await quiet();
    expect([sessionQuestions(b.win).length, b.win.loads, b.navigator.cachedPages]).toEqual([1, [], 1]);
  });

  it('ignores a message of any other shape — it does not even ask the server', async () => {
    const { channels, tab } = browser();
    const b = tab('/users/1');
    await quiet();
    for (const data of [
      { v: 1, epoch: 42, props: { secret: SECRET } },
      { v: 1, epoch: 'e2', props: {} },
      { v: 2, epoch: 'e2' },
      { epoch: 'e2' },
      'e2',
      null,
      { v: 1, epoch: 'not an epoch!' },
      { v: 1, epoch: 'e'.repeat(65) },
    ]) {
      channels.inject(data);
    }
    await quiet();
    expect([sessionQuestions(b.win).length, b.win.loads]).toEqual([0, []]);
    expect(isTabSyncMessage({ v: 1, epoch: 'e2' })).toBe(true);
    // The same epoch it has: nothing either.
    channels.inject({ v: 1, epoch: 'e1' });
    await quiet();
    expect(sessionQuestions(b.win)).toHaveLength(0);
  });

  it('a message of an epoch the server does not have (a stale tab): one question, no reload', async () => {
    const { channels, tab } = browser();
    const b = tab('/users/1');
    channels.inject({ v: 1, epoch: 'old' });
    await quiet();
    expect([sessionQuestions(b.win).length, b.win.loads]).toEqual([1, []]);
  });

  it('unsaved changes on screen: the user is asked instead — no keeps the page; pages fetched ahead go', async () => {
    const { server, tab } = browser();
    const b = tab('/users/1');
    await b.navigator.use(prefetch).prefetch('/users/3');
    b.navigator.use(guard).add({ message: 'Unsaved' });
    server.epoch = 'e2';
    tab('/login', { secret: false });
    await quiet();
    expect(b.win.asked).toEqual([`confirm ${DEFAULT_SESSION_CHANGED_MESSAGE}`]);
    expect(b.win.loads).toEqual([]);
    expect(b.navigator.use(prefetch).size).toBe(0);
    // The page's next answer is of the new epoch: nothing more is asked.
    await b.navigator.reload({ only: ['secret'] });
    await quiet();
    expect(b.win.asked).toHaveLength(1);
  });

  it('unsaved changes, yes: the page loads again — the browser asks nothing more (no beforeunload question)', async () => {
    const { server, tab } = browser();
    const b = tab('/users/1');
    b.win.confirmAnswer = true;
    b.navigator.use(guard).add({ message: 'Unsaved' });
    server.epoch = 'e2';
    tab('/login', { secret: false });
    await quiet();
    expect(b.win.loads).toEqual(['reload']);
    expect(b.win.unload()).toBe(false);
  });

  it('unsaved changes in a hidden tab: asked when it becomes visible, not before', async () => {
    const { server, tab } = browser();
    const b = tab('/users/1');
    b.navigator.use(guard).add({ message: 'Unsaved' });
    b.win.hide();
    server.epoch = 'e2';
    tab('/login', { secret: false });
    await quiet();
    expect(b.win.asked).toEqual([]);
    b.win.show();
    await quiet();
    expect(b.win.asked).toEqual([`confirm ${DEFAULT_SESSION_CHANGED_MESSAGE}`]);
  });

  it('every history entry holds the epoch it was written under — a position, nothing the page showed', async () => {
    const { tab } = browser();
    const b = tab('/users/1');
    await b.navigator.visit('/users/2');
    expect(b.win.entries.map((entry) => JSON.parse(entry.state).epoch)).toEqual(['e1', 'e1']);
    expect(b.win.entries.some((entry) => entry.state.includes(SECRET))).toBe(false);
  });

  it('Back to an entry of the old epoch loads it from the server — never the page in memory', async () => {
    const { server, tab } = browser();
    const b = tab('/users/1');
    await b.navigator.visit('/users/2');
    let unsaved = true;
    b.navigator.use(guard).add({ message: 'Unsaved', active: () => unsaved });
    server.epoch = 'e2';
    tab('/login', { secret: false });
    await quiet();
    expect(b.win.loads).toEqual([]); // the user kept the page
    unsaved = false; // and saved it
    b.win.back();
    await quiet();
    expect(b.win.loads).toEqual(['reload']);
    expect(b.visible().url).toBe('/users/2'); // nothing of /users/1 came back from memory
  });

  it('an answer of its own brings a new epoch (a sign-in by the remember-me cookie): the other entries go, the other tabs hear it', async () => {
    const { channels, server, tab } = browser();
    const b = tab('/users/1');
    const c = tab('/users/9');
    await b.navigator.visit('/users/2');
    const changes: EpochChange[] = [];
    b.navigator.use(tabSync).on('epoch', (change) => void changes.push(change));
    server.epoch = 'e2';
    await b.navigator.visit('/users/3');
    await quiet();
    expect(changes).toEqual([{ previous: 'e1', next: 'e2', origin: 'self' }]);
    expect(b.win.loads).toEqual([]);
    expect(b.navigator.cachedPages).toBe(1);
    expect(JSON.parse(b.win.current.state).epoch).toBe('e2');
    expect(channels.posted.at(-1)).toEqual({ name: 'marmeon', data: { v: 1, epoch: 'e2' } });
    // The other tab asks and loads again.
    expect([sessionQuestions(c.win).length, c.win.loads]).toEqual([1, ['reload']]);
  });

  it('the epoch event says what changed and why — before the tab lets go of anything', async () => {
    const { server, tab } = browser();
    const b = tab('/users/1');
    const seen: [EpochChange, number][] = [];
    b.navigator.use(tabSync).on('epoch', (change) => void seen.push([change, b.navigator.cachedPages]));
    server.epoch = 'e2';
    tab('/login', { secret: false });
    await quiet();
    expect(seen).toEqual([[{ previous: 'e1', next: 'e2', origin: 'tab' }, 1]]);
    // The document is left: what the feature kept went with it (its slot).
    expect(b.navigator.use(tabSync).epoch).toBeUndefined();
  });

  it('names its document on every request: the same id for one document, another one in another tab', async () => {
    const { tab } = browser();
    const b = tab('/users/1');
    const c = tab('/users/9');
    await b.navigator.visit('/users/2');
    await b.navigator.reload({ async: true });
    await c.navigator.visit('/users/8');
    const ids = (win: FakeWindow) => [...new Set(win.requests.map((request) => request.headers[DOCUMENT_HEADER]))];
    expect(ids(b.win)).toHaveLength(1);
    expect(ids(c.win)).toHaveLength(1);
    expect(ids(b.win)[0]).toMatch(/^[0-9a-f]{24}$/);
    expect(ids(b.win)[0]).not.toBe(ids(c.win)[0]);
  });

  it('a document left (a 409) closes its channel — it hears nothing any more', async () => {
    const { channels, server, tab } = browser();
    const b = tab('/users/1');
    expect(channels.open).toBe(1);
    b.win.handler = () => new Response(null, { status: 409, headers: { 'x-marmeon-location': '/login' } });
    await b.navigator.visit('/users/2');
    expect(channels.open).toBe(0);
    server.epoch = 'e2';
    channels.inject({ v: 1, epoch: 'e2' });
    await quiet();
    expect(sessionQuestions(b.win)).toHaveLength(0);
  });

  it('without BroadcastChannel (an old browser): it still asks when the tab becomes visible', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    let epoch = 'e1';
    win.handler = () => Response.json({ epoch });
    boot(win, { ...page('/users/1'), epoch: 'e1' }, { features: [tabSync] });
    epoch = 'e2';
    win.hide();
    win.show();
    await quiet();
    expect(win.loads).toEqual(['reload']);
  });
});

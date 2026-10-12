/**
 * The navigator on the Navigation API: it commits its own visits as its own navigations (`info`), follows
 * Back/Forward to its own entries through `navigate`, and leaves everything else to the browser — a plain link, a form, another
 * site. The guard cancels a Back where the browser lets it (a fresh user activation) and otherwise goes back by the browser's key.
 * The fake is modelled on Chrome 154; the suites in navigation.test.ts, layer.test.ts, interaction.test.ts and
 * security-matrix.test.ts run on this path and on the History fallback's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest } from './confirm.ts';
import { guard } from './features/guard.ts';
import { tabSync } from './features/tab-sync.ts';
import { HistoryWriter } from './history.ts';
import { Navigator } from './navigation.ts';
import { boot, FakeChannels, FakeWindow, ORIGIN, page, pageResponse, settle } from './test-window.ts';

/** A tab with the Navigation API whose server answers every URL with a page of that path. */
function tab(url = '/a', options: Parameters<typeof boot>[2] = {}) {
  const win = new FakeWindow(`${ORIGIN}${url}`, undefined, 'navigation');
  win.handler = (requested) => pageResponse(page(new URL(requested).pathname + new URL(requested).search, { at: new URL(requested).pathname }));
  return { win, ...boot(win, page(url, { at: url }), options) };
}

/** A confirm that answers in turn — and records what it was asked. */
const asking = (...answers: boolean[]) => {
  const asked: ConfirmRequest[] = [];
  return { asked, confirm: (request: ConfirmRequest) => (asked.push(request), answers.shift() ?? false) };
};

/** Lets traversals (a task later), their handlers and renders finish. */
const settled = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) await settle();
};

describe('the navigator on the Navigation API — only its own navigations', () => {
  it('commits a visit as its own navigation — intercepted, nothing loads, scroll and focus stay its own; history.state stays null', async () => {
    const { win, navigator, visible } = tab();
    await navigator.visit('/b');
    const own = win.navigation!.events.at(-1)!;
    expect([own.navigationType, own.userInitiated, own.intercepted]).toEqual(['push', false, [{ scroll: 'manual', focusReset: 'manual' }]]);
    expect(win.loads).toEqual([]);
    expect(win.current.url).toBe(`${ORIGIN}/b`);
    expect(visible().url).toBe('/b');
    expect(win.history.state).toBeNull();
    expect(win.navigation!.currentEntry.getState()).toMatchObject({ component: 'pages/Show', url: '/b' });
  });

  it('a plain link, a plain GET form and another site stay the browser’s — not intercepted, the document loads', async () => {
    const { win, navigator, visible } = tab();
    await navigator.visit('/b');
    const requests = win.requests.length;
    win.follow('/plain');
    win.follow('/search?q=ada');
    win.follow('https://evil.test/x');
    const [link, form, foreign] = win.navigation!.events.slice(-3);
    expect([link, form, foreign].map((event) => [event!.navigationType, event!.userInitiated, event!.intercepted.length]), 'the navigator intercepted a navigation that is not its own').toEqual([
      ['push', true, 0],
      ['push', true, 0],
      ['push', true, 0],
    ]);
    expect(foreign!.canIntercept).toBe(false);
    expect(win.loads, 'the navigator intercepted a navigation that is not its own').toEqual([`assign ${ORIGIN}/plain`, `assign ${ORIGIN}/search?q=ada`, 'assign https://evil.test/x']);
    expect(win.requests).toHaveLength(requests);
    expect(visible().url).toBe('/b');
  });

  it('Back to an entry of an earlier document (a full load came in between) is the browser’s — never even tried', async () => {
    const { win, navigator } = tab();
    await navigator.visit('/b');
    // A full load since: the entries before are another document's — same origin, with the navigator's state.
    win.entries[0]!.crossDocument = true;
    win.back();
    const back = win.navigation!.events.at(-1)!;
    expect([back.canIntercept, back.cancelable]).toEqual([false, false]);
    expect(back.attempts, 'the navigator tried to intercept what it cannot').toBe(0);
    expect(win.loads).toEqual([`traverse ${ORIGIN}/a`]);
  });

  it('follows Back/Forward in WebKit, whose traversal destination has no state — read from the entry it goes to', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`, undefined, 'webkit');
    win.handler = (requested) => pageResponse(page(new URL(requested).pathname, { at: new URL(requested).pathname }));
    const { navigator, visible } = boot(win, page('/a', { at: '/a' }));
    await navigator.visit('/b');
    win.back();
    await settled();
    const back = win.navigation!.events.at(-1)!;
    expect([back.navigationType, back.destination.getState(), back.intercepted.length]).toEqual(['traverse', undefined, 1]);
    expect(visible().url).toBe('/a');
    expect(win.loads).toEqual([]);
    win.forward();
    await settled();
    expect(visible().url).toBe('/b');
    expect(win.loads).toEqual([]);
  });

  it('follows Back/Forward to its own entries from memory — intercepted, its scroll restored, the browser’s loading indicator only while it runs', async () => {
    const { win, navigator, visible } = tab();
    win.scrollTo(0, 640);
    await navigator.visit('/b');
    const requests = win.requests.length;
    win.back();
    const back = win.navigation!.events.at(-1)!;
    expect([back.navigationType, back.userInitiated, back.cancelable, back.intercepted.length]).toEqual(['traverse', true, false, 1]);
    expect(win.navigation!.transition).toMatchObject({ navigationType: 'traverse' });
    await settled();
    expect(win.navigation!.transition).toBeNull();
    expect(visible().url).toBe('/a');
    expect(win.scrollY, 'the scroll position was not restored').toBe(640);
    expect(win.requests).toHaveLength(requests);
  });

  it('shows the browser’s loading indicator while Back asks the server for an entry not in memory (after a reload) — `navigation.transition`', async () => {
    const first = tab();
    await first.navigator.visit('/b');
    first.stop();
    // A reload on /b: a new document, the entries (and their states) survive — the pages in memory do not.
    const { win } = first;
    let answer!: (response: Response) => void;
    win.handler = () => new Promise((resolve) => (answer = resolve));
    const reloaded = boot(win, page('/b', { at: '/b' }));
    win.back();
    await settle();
    expect(win.requests.at(-1)?.url).toBe(`${ORIGIN}/a`);
    expect(win.navigation!.transition).toMatchObject({ navigationType: 'traverse' });
    answer(pageResponse(page('/a', { at: 'fresh' })));
    await settled();
    expect(win.navigation!.transition).toBeNull();
    expect(reloaded.visible().props).toEqual({ at: 'fresh' });
  });

  it('heals an entry another script’s `history.replaceState` erased — written again when it is left, so Forward finds it', async () => {
    const { win, navigator, visible } = tab();
    await navigator.visit('/b');
    win.scroll(500);
    // An analytics script rewrites the entry (`replaceState(history.state, '')`): the Navigation API's state of it is gone.
    win.history.replaceState(win.history.state, '');
    expect(win.current.navigation).toBeUndefined();
    win.back();
    await settled();
    expect(JSON.parse(win.entries[1]!.state), 'the entry left was not written again').toMatchObject({ url: '/b', scroll: { x: 0, y: 500 } });
    const requests = win.requests.length;
    win.forward();
    await settled();
    expect(visible().url, 'Forward found the erased entry and followed nothing').toBe('/b');
    expect(win.scrollY).toBe(500);
    expect(win.requests).toHaveLength(requests);
  });
});

describe('the guard on the Navigation API', () => {
  it('Back right after a click is cancelled — the URL never changes; asked once, Leave goes a task later', async () => {
    const { asked, confirm } = asking(false, true);
    const { win, navigator, visible } = tab('/users/1', { confirm });
    await navigator.visit('/users/1/edit');
    const stop = navigator.use(guard).add({ message: 'Unsaved.' });
    const shown = win.shownUrls.length;
    // Stay.
    win.activate();
    win.back();
    await settled();
    const cancelled = win.navigation!.events.at(-1)!;
    expect([cancelled.navigationType, cancelled.cancelable, cancelled.defaultPrevented], 'the Back was not cancelled').toEqual(['traverse', true, true]);
    expect(asked).toHaveLength(1);
    expect(win.shownUrls.slice(shown), 'the address bar changed').toEqual([]);
    expect(visible().url).toBe('/users/1/edit');
    // Leave — answered at once: the browser refuses another traversal in the task that cancelled one (InvalidStateError), so the
    // guard goes a task later.
    win.activate();
    win.back();
    await settled(6);
    expect(asked).toHaveLength(2);
    expect(win.shownUrls.slice(shown), 'Leave did not go').toEqual([`${ORIGIN}/users/1`]);
    expect(visible().url).toBe('/users/1');
    stop();
  });

  it('without an activation (after a session restore) Back goes, and comes back at once to the entry it left — by the browser’s key', async () => {
    const first = tab('/a');
    await first.navigator.visit('/b');
    await first.navigator.visit('/c');
    first.win.back();
    await settled();
    first.stop();
    // The session is restored on /b — a new document in the middle of the history (A, B, C): no count of this app knows where it is.
    const { win } = first;
    const { asked, confirm } = asking(false);
    const restored = boot(win, page('/b', { at: '/b' }), { confirm });
    const stop = restored.navigator.use(guard).add({ message: 'Unsaved.' });
    const shown = win.shownUrls.length;
    const rendered = restored.shown.length;
    win.back();
    await settled(6);
    const [back, undo] = win.navigation!.events.filter((event) => event.navigationType === 'traverse').slice(-2);
    // There and back: the address bar showed /a a moment — the page never changed.
    expect(win.shownUrls.slice(shown), 'the guard went back to another entry than the one it left').toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`]);
    expect([back!.cancelable, back!.userInitiated, undo!.userInitiated]).toEqual([false, true, false]);
    expect(asked).toHaveLength(1);
    expect(win.current.url).toBe(`${ORIGIN}/b`);
    expect(restored.shown).toHaveLength(rendered);
    stop();
  });

  it('two Backs in a row: the second is not cancelable any more (the activation is used up) — it is undone, and asked again', async () => {
    const { asked, confirm } = asking(false, false);
    const { win, navigator, visible } = tab('/a', { confirm });
    await navigator.visit('/b');
    await navigator.visit('/c');
    navigator.use(guard).add({ message: 'Unsaved.' });
    win.activate();
    win.back();
    await settled();
    win.back();
    await settled(6);
    const traversals = win.navigation!.events.filter((event) => event.navigationType === 'traverse');
    expect(traversals.slice(0, 2).map((event) => event.cancelable)).toEqual([true, false]);
    expect(asked).toHaveLength(2);
    expect(win.current.url).toBe(`${ORIGIN}/c`);
    expect(visible().url).toBe('/c');
  });

  it('closing the tab or reloading with a guard still gets the browser’s own question (`beforeunload`)', () => {
    const { win, navigator } = tab();
    expect(win.listening('window:beforeunload')).toBe(0);
    const stop = navigator.use(guard).add({ message: 'Unsaved.' });
    expect(win.listening('window:beforeunload'), 'no beforeunload listener while guarded').toBe(1);
    expect(win.unload()).toBe(true);
    stop();
    expect(win.unload()).toBe(false);
  });
});

describe('tab sync writes its epoch through the history writer — no wrapping', () => {
  it('every entry holds the epoch it was written under; the writer’s methods stay its own', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`, new FakeChannels(), 'navigation');
    win.handler = (url) => pageResponse({ ...page(new URL(url).pathname), epoch: 'e1' });
    const { navigator } = boot(win, { ...page('/a'), epoch: 'e1' }, { features: [tabSync] });
    await navigator.visit('/b');
    expect(win.entries.map((entry) => JSON.parse(entry.state).epoch), 'an entry without its epoch').toEqual(['e1', 'e1']);
    const host = navigator.use({ name: 'peek', setup: (given) => given }) as { history: HistoryWriter };
    expect(Object.hasOwn(host.history, 'push') || Object.hasOwn(host.history, 'replace')).toBe(false);
    expect(host.history.push).toBe(HistoryWriter.prototype.push);
  });
});

describe('without the Navigation API', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
    vi.restoreAllMocks();
  });

  it('says so in development when the History fallback is not attached (C13) — the navigator still writes its entries', () => {
    process.env.NODE_ENV = 'development';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = new FakeWindow(`${ORIGIN}/a`, undefined, 'history');
    const navigator = new Navigator({ initialPage: page('/a'), window: win, render: async () => undefined });
    navigator.start();
    expect(warn.mock.calls.map(([message]) => String(message).slice(0, 18))).toEqual(['[marmeon:C13] This']);
    expect(JSON.parse(win.current.state)).toMatchObject({ url: '/a' });
  });
});

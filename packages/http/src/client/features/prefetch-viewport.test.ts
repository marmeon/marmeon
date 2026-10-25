import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_HEADER, PROTOCOL_VERSION } from '../../protocol.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse } from '../test-window.ts';
import { observeWith } from '../lazy.ts';
import { prefetch } from './prefetch.ts';

/** A link in the document — only its identity matters to the observer. */
const link = (): Element => ({}) as Element;

/** A document whose requests wait until the test answers them. */
function setup() {
  const win = new FakeWindow(`${ORIGIN}/start`);
  const waiting: (() => void)[] = [];
  let running = 0;
  let mostAtOnce = 0;
  win.handler = (url) => {
    running++;
    mostAtOnce = Math.max(mostAtOnce, running);
    return new Promise((resolve) => {
      waiting.push(() => {
        running--;
        resolve(pageResponse(page(new URL(url).pathname)));
      });
    });
  };
  const { navigator } = boot(win, page('/start'));
  const prefetches = navigator.use(prefetch);
  /** Answers every request under way, and lets what follows start. */
  const answer = async () => {
    for (const respond of waiting.splice(0)) respond();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { win, navigator, prefetches, answer, atOnce: () => mostAtOnce, underWay: () => waiting.length };
}

/** `count` links, each half in view at once. */
function show(win: FakeWindow, prefetches: ReturnType<typeof setup>['prefetches'], count: number) {
  const elements = Array.from({ length: count }, link);
  elements.forEach((element, index) => prefetches.observe(element, `/page-${index}`));
  for (const element of elements) win.see(element, 0.5);
  return elements;
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('prefetch in the viewport', () => {
  it('fetches a link that stayed half in view for 250 ms — a prefetch like any other', async () => {
    const { win, prefetches, answer } = setup();
    const [element] = show(win, prefetches, 1);
    await vi.advanceTimersByTimeAsync(249);
    expect(win.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(win.requests).toEqual([{ url: `${ORIGIN}/page-0`, method: 'GET', headers: expect.objectContaining({ [PAGE_HEADER]: PROTOCOL_VERSION, purpose: 'prefetch' }) }]);
    await answer();
    expect(prefetches.size).toBe(1);
    // Fetched: no longer watched.
    expect(win.watching.has(element!)).toBe(false);
  });

  it('50 visible links: never more than 2 at once, 20 in all', async () => {
    const { win, prefetches, answer, atOnce, underWay } = setup();
    show(win, prefetches, 50);
    await vi.advanceTimersByTimeAsync(250);
    expect(underWay()).toBe(2);
    for (let round = 0; round < 30; round++) await answer();
    expect(win.requests).toHaveLength(20);
    expect(atOnce()).toBe(2);
  });

  it('a visit that lands starts the count of 20 again', async () => {
    const { win, navigator, prefetches, answer } = setup();
    show(win, prefetches, 50);
    await vi.advanceTimersByTimeAsync(250);
    for (let round = 0; round < 30; round++) await answer();
    expect(win.requests).toHaveLength(20);

    win.handler = (url) => pageResponse(page(new URL(url).pathname));
    await navigator.visit('/elsewhere');
    await vi.advanceTimersByTimeAsync(0);
    const prefetched = win.requests.filter((request) => request.headers.purpose === 'prefetch');
    // The links still waiting go on, again up to 20 — the visit itself is no prefetch.
    expect(prefetched).toHaveLength(40);
    expect(win.requests).toHaveLength(41);
  });

  it('a reload of the same page (a poll, a live update, "load more") does not start the count again', async () => {
    const { win, navigator, prefetches, answer } = setup();
    show(win, prefetches, 50);
    await vi.advanceTimersByTimeAsync(250);
    for (let round = 0; round < 30; round++) await answer();
    expect(win.requests).toHaveLength(20);

    win.handler = (url) => pageResponse(page(new URL(url).pathname));
    await navigator.reload({ only: ['stats'] });
    await navigator.reload({ async: true });
    await navigator.reload({ data: { cursor: 'x' }, preserveUrl: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(win.requests.filter((request) => request.headers.purpose === 'prefetch')).toHaveLength(20);
    expect(win.requests).toHaveLength(23);
  });

  it('a link that came into view while the tab was hidden is fetched when it is shown again', async () => {
    const { win, prefetches } = setup();
    win.hide();
    show(win, prefetches, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(win.requests).toEqual([]);
    win.show();
    await vi.advanceTimersByTimeAsync(250);
    expect(win.requests.map((request) => request.url)).toEqual([`${ORIGIN}/page-0`]);
  });

  it('a link to the page on screen, a page held already, or a repeated link costs none of the 20', async () => {
    const { win, prefetches, answer } = setup();
    const elements = [link(), link(), ...Array.from({ length: 30 }, link)];
    prefetches.observe(elements[0]!, '/start'); // the page on screen
    prefetches.observe(elements[1]!, '/start'); // again
    elements.slice(2).forEach((element, index) => prefetches.observe(element, `/page-${index % 25}`)); // 5 repeated
    for (const element of elements) win.see(element, 1);
    await vi.advanceTimersByTimeAsync(250);
    for (let round = 0; round < 40; round++) await answer();
    expect(new Set(win.requests.map((request) => request.url)).size).toBe(20);
    expect(win.requests).toHaveLength(20);
  });

  it('a link that leaves the view before its turn drops out of the queue', async () => {
    const { win, prefetches, answer } = setup();
    const elements = show(win, prefetches, 4);
    await vi.advanceTimersByTimeAsync(250); // 0 and 1 run, 2 and 3 wait
    win.see(elements[2]!, 0.2);
    await answer();
    await answer();
    expect(win.requests.map((request) => request.url)).toEqual([`${ORIGIN}/page-0`, `${ORIGIN}/page-1`, `${ORIGIN}/page-3`]);
  });

  it('a link that leaves the view within its dwell asks nothing', async () => {
    const { win, prefetches } = setup();
    const [element] = show(win, prefetches, 1);
    await vi.advanceTimersByTimeAsync(200);
    win.see(element!, 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(win.requests).toEqual([]);
  });

  it('less than half in view is not enough', async () => {
    const { win, prefetches } = setup();
    const element = link();
    prefetches.observe(element, '/page');
    win.see(element, 0.49);
    await vi.advanceTimersByTimeAsync(1000);
    expect(win.requests).toEqual([]);
  });

  it.each([
    ['a hidden document', (win: FakeWindow) => void (win.visibilityState = 'hidden')],
    ['Save-Data', (win: FakeWindow) => void (win.navigator = { connection: { saveData: true } })],
    ['a 2g connection', (win: FakeWindow) => void (win.navigator = { connection: { effectiveType: '2g' } })],
    ['a slow-2g connection', (win: FakeWindow) => void (win.navigator = { connection: { effectiveType: 'slow-2g' } })],
  ])('asks nothing on %s', async (_name, change) => {
    const { win, prefetches } = setup();
    change(win);
    show(win, prefetches, 5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(win.requests).toEqual([]);
  });

  it('a document hidden while links wait asks nothing more', async () => {
    const { win, prefetches, answer } = setup();
    show(win, prefetches, 5);
    await vi.advanceTimersByTimeAsync(250); // 2 run, 3 wait
    win.visibilityState = 'hidden';
    await answer();
    await vi.advanceTimersByTimeAsync(1000);
    expect(win.requests).toHaveLength(2);
  });

  it('a faster connection than 2g is no reason to wait', async () => {
    const { win, prefetches } = setup();
    win.navigator = { connection: { effectiveType: '4g', saveData: false } };
    show(win, prefetches, 1);
    await vi.advanceTimersByTimeAsync(250);
    expect(win.requests).toHaveLength(1);
  });

  it('stops watching when the link goes — before the dwell is over', async () => {
    const { win, prefetches } = setup();
    const element = link();
    const stop = prefetches.observe(element, '/page');
    win.see(element, 1);
    stop();
    expect(win.watching.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(win.requests).toEqual([]);
  });

  it('stops watching a link that unmounts before the prefetch code is there', async () => {
    const win = new FakeWindow(`${ORIGIN}/start`);
    win.handler = (url) => pageResponse(page(new URL(url).pathname));
    const { navigator } = boot(win, page('/start'));
    const stop = observeWith(navigator, link(), '/page');
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(win.watching.size).toBe(0);
    expect(win.requests).toEqual([]);
  });

  it('loads the prefetch code and then watches', async () => {
    const win = new FakeWindow(`${ORIGIN}/start`);
    win.handler = (url) => pageResponse(page(new URL(url).pathname));
    const { navigator } = boot(win, page('/start'));
    const element = link();
    observeWith(navigator, element, '/page');
    await vi.advanceTimersByTimeAsync(0);
    win.see(element, 1);
    await vi.advanceTimersByTimeAsync(250);
    expect(win.requests.map((request) => request.url)).toEqual([`${ORIGIN}/page`]);
  });

  it('does nothing without an IntersectionObserver, nor for another site', () => {
    const { win, prefetches } = setup();
    prefetches.observe(link(), 'https://elsewhere.test/page');
    expect(win.watching.size).toBe(0);
    win.IntersectionObserver = undefined;
    prefetches.observe(link(), '/page');
    expect(win.watching.size).toBe(0);
  });

  it('keeps the options of the link (cacheFor)', async () => {
    const { win, prefetches, answer } = setup();
    const element = link();
    prefetches.observe(element, '/page', { cacheFor: 1000 });
    win.see(element, 1);
    await vi.advanceTimersByTimeAsync(250);
    await answer();
    expect(prefetches.ready('/page', false)).toBe(true);
    await vi.advanceTimersByTimeAsync(1001);
    expect(prefetches.ready('/page', false)).toBe(false);
  });
});

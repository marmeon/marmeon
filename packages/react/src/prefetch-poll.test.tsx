// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { PAGE_HEADER, type PageObject } from '@marmeon/http/page';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp } from './app.tsx';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { usePoll } from './use-poll.ts';
import { WhenVisible } from './when-visible.tsx';
import { loadHistoryFallback } from '@marmeon/http/client';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Links() {
  return (
    <nav>
      <Link href="/b" prefetch data-testid="hover">
        B
      </Link>
      <Link href="/c" prefetch="mount" data-testid="mount">
        C
      </Link>
      {/* @ts-expect-error — actions are never prefetched: Type 'true' is not assignable to type 'undefined'. */}
      <Link href="/logout" method="post" prefetch data-testid="post">
        Sign out
      </Link>
      {/* @ts-expect-error — nor on mount: the page would be fetched with a GET (a GET /logout!) */}
      <Link href="/logout?mounted" method="post" prefetch="mount" data-testid="post-mount">
        Sign out
      </Link>
      <Link href="/d" data-testid="plain">
        D
      </Link>
    </nav>
  );
}

function B({ name }: { name: string }) {
  return <p data-page="b">{name}</p>;
}

let polls = 0;
function Polling({ count }: { count: number }) {
  usePoll<{ count: number }>(40, { only: ['count'] });
  return <p data-testid="count">{count}</p>;
}

function Lazy({ stats, list }: { stats?: number; list: { data: number[]; next: string | null } }) {
  return (
    <div>
      <WhenVisible<{ stats?: number }> data="stats" fallback={<p data-testid="loading">Loading…</p>}>
        {() => <p data-testid="stats">{stats}</p>}
      </WhenVisible>
      <ul data-testid="list">{list.data.map((item) => <li key={item}>{item}</li>)}</ul>
      {list.next && <WhenVisible always params={{ data: { cursor: list.next }, only: ['list'], preserveUrl: true }} fallback={<p data-testid="more">Loading more…</p>} />}
    </div>
  );
}

const pages: Record<string, PageComponent> = { Links, B, Polling, Lazy };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`../modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const page = (name: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ component: `app/${name}`, props, url, version: null });
const respond = (body: PageObject) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: 'true' } });

let server: (url: string, init: RequestInit) => Response | Promise<Response>;
let requests: { url: string; method: string; headers: Record<string, string> }[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/a');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  requests = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    requests.push({ url: String(input), method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) } });
    return server(String(input), init);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

async function mount(initial: PageObject) {
  const Component = await resolve(initial.component);
  root = createRoot(container);
  await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} />));
}

const $ = (selector: string) => container.querySelector(selector);
const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const pointer = (testId: string, type: 'mouseover' | 'mouseout' | 'mousedown') =>
  act(async () => void $(`[data-testid="${testId}"]`)!.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, relatedTarget: document.body })));

describe('<Link prefetch>', () => {
  beforeEach(() => {
    server = (url) => respond(page('B', new URL(url, location.href).pathname, { name: `page ${new URL(url, location.href).pathname}` }));
  });

  it('fetches the page when the pointer rests on the link — the click shows it without asking again', async () => {
    await mount(page('Links', '/a'));
    expect(requests.map((r) => r.url)).toEqual(['/c']); // prefetch="mount"
    await pointer('hover', 'mouseover');
    await wait(100);
    expect(requests.map((r) => r.url)).toEqual(['/c', '/b']);
    expect(requests[1]!.headers).toMatchObject({ purpose: 'prefetch', [PAGE_HEADER]: 'true' });

    await act(async () => ($('[data-testid="hover"]') as HTMLAnchorElement).click());
    await wait(10);
    expect($('[data-page="b"]')!.textContent).toBe('page /b');
    expect(requests).toHaveLength(2);
  });

  it('passing over a link does not prefetch it; a link without `prefetch` never does', async () => {
    await mount(page('Links', '/a'));
    await pointer('hover', 'mouseover');
    await pointer('hover', 'mouseout');
    await pointer('plain', 'mouseover');
    await pointer('plain', 'mousedown');
    await wait(100);
    expect(requests.map((r) => r.url)).toEqual(['/c']);
  });

  it('prefetches at once when the link is pressed (touch screens have no hover)', async () => {
    await mount(page('Links', '/a'));
    await pointer('hover', 'mousedown');
    expect(requests.map((r) => r.url)).toEqual(['/c', '/b']);
  });

  it('an action (method="post") is never prefetched — not on hover, not when pressed', async () => {
    await mount(page('Links', '/a'));
    await pointer('post', 'mouseover');
    await pointer('post', 'mousedown');
    await wait(100);
    expect(requests.filter((r) => r.url.startsWith('/logout'))).toEqual([]); // the mounted one neither
  });
});

describe('<Link> to an action', () => {
  it('sends one visit with JavaScript — the form around its button is not submitted as well', async () => {
    server = () => respond(page('B', '/b', { name: 'signed out' }));
    await mount(page('Links', '/a'));
    let submitted = 0;
    container.addEventListener('submit', () => submitted++, true);
    expect($('[data-testid="post"]')!.closest('form')?.getAttribute('action')).toBe('/logout');
    await act(async () => ($('[data-testid="post"]') as HTMLButtonElement).click());
    await wait(10);
    expect(requests.filter((r) => r.url.startsWith('/logout')).map((r) => r.method)).toEqual(['POST']);
    expect(submitted).toBe(0);
    expect($('[data-page="b"]')!.textContent).toBe('signed out');
  });
});

/** Hides or shows the tab, as the browser does. */
function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('usePoll', () => {
  beforeEach(() => {
    polls = 0;
    server = () => respond(page('Polling', '/a', { count: ++polls }));
  });
  afterEach(() => visibility('visible'));

  it('reloads the props in the background every interval — paused while the tab is hidden, stopped on unmount', async () => {
    await mount(page('Polling', '/a', { count: 0 }));
    await wait(100);
    const polled = requests.length;
    expect(polled).toBeGreaterThanOrEqual(1);
    expect(requests[0]!.headers).toMatchObject({ 'x-marmeon-partial-data': 'count' });
    expect($('[data-testid="count"]')!.textContent).toBe(String(polls));

    visibility('hidden');
    await wait(150);
    const hidden = requests.length;
    expect(hidden - polled).toBeLessThanOrEqual(1); // a turn already under way may finish
    visibility('visible');
    await wait(20);
    expect(requests.length).toBeGreaterThan(hidden); // caught up right away

    await act(async () => root.unmount());
    const stopped = requests.length;
    await wait(150);
    expect(requests.length).toBe(stopped);
    await mount(page('Polling', '/a', { count: 0 })); // for afterEach
  });
});

/** An IntersectionObserver the test drives: `show()` scrolls every observed element into view. */
class FakeObserver {
  static all: FakeObserver[] = [];
  readonly observed = new Set<Element>();
  readonly #callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
    FakeObserver.all.push(this);
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
  }
  static show() {
    for (const observer of FakeObserver.all) {
      const entries = [...observer.observed].map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry);
      if (entries.length > 0) observer.#callback(entries, observer as unknown as IntersectionObserver);
    }
  }
}

describe('<WhenVisible>', () => {
  beforeEach(() => {
    FakeObserver.all = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    server = (url, init) => {
      const only = (init.headers as Record<string, string>)['x-marmeon-partial-data'];
      if (only === 'stats') return respond(page('Lazy', '/a', { stats: 42 }));
      const cursor = new URL(url, location.href).searchParams.get('cursor');
      return respond({ ...page('Lazy', `/a?cursor=${cursor}`, { list: cursor === 'p2' ? { data: [3, 4], next: 'p3' } : { data: [5], next: null } }), deepMergeProps: ['list'] });
    };
  });
  afterEach(() => void vi.unstubAllGlobals());

  it('loads its props when scrolled into view — not before, and once', async () => {
    await mount(page('Lazy', '/a', { list: { data: [1, 2], next: null } }));
    expect($('[data-testid="loading"]')).not.toBeNull();
    expect(requests).toEqual([]);

    await act(async () => FakeObserver.show());
    await wait(10);
    expect($('[data-testid="stats"]')!.textContent).toBe('42');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers).toMatchObject({ 'x-marmeon-partial-component': 'app/Lazy', 'x-marmeon-partial-data': 'stats' });

    await act(async () => FakeObserver.show());
    await wait(10);
    expect(requests).toHaveLength(1);
  });

  it('with `always`: infinite scroll — every time the end comes into view, the next page is appended; the URL stays', async () => {
    await mount(page('Lazy', '/a', { stats: 1, list: { data: [1, 2], next: 'p2' } }));
    await act(async () => FakeObserver.show());
    await wait(10);
    expect(requests.map((r) => r.url)).toEqual(['/a?cursor=p2']);
    expect([...$('[data-testid="list"]')!.children].map((li) => li.textContent)).toEqual(['1', '2', '3', '4']);

    await act(async () => FakeObserver.show());
    await wait(10);
    expect(requests.map((r) => r.url)).toEqual(['/a?cursor=p2', '/a?cursor=p3']);
    expect([...$('[data-testid="list"]')!.children].map((li) => li.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect($('[data-testid="more"]')).toBeNull(); // no next page: the sentinel is gone
    expect(location.pathname + location.search).toBe('/a');
  });
});

// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { loadHistoryFallback } from '@marmeon/http/client/adapter';
import { PAGE_HEADER, type PageObject, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp } from './app.tsx';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Links() {
  return (
    <nav>
      <Link href="/in-view" prefetch="viewport" data-testid="view">
        In view
      </Link>
      <Link href="/both" prefetch={['hover', 'viewport']} cacheForMs={5000} data-testid="both">
        Both
      </Link>
      <Link href="/partial" prefetch="viewport" only={['stats']} data-testid="partial">
        Partial
      </Link>
      {/* @ts-expect-error — actions are never prefetched, in view neither: Type '"viewport"' is not assignable to type 'undefined'. */}
      <Link href="/logout" method="post" prefetch="viewport" data-testid="post">
        Sign out
      </Link>
      <Link href="https://elsewhere.test/page" prefetch="viewport" data-testid="external">
        Elsewhere
      </Link>
      <Link href="/plain" data-testid="plain">
        Plain
      </Link>
    </nav>
  );
}

function Empty() {
  return <p data-page="empty">nothing</p>;
}

function Many() {
  return (
    <ul>
      {Array.from({ length: 50 }, (_, index) => (
        <li key={index}>
          <Link href={`/item-${index}`} prefetch="viewport" data-testid={`item-${index}`}>
            Item {index}
          </Link>
        </li>
      ))}
    </ul>
  );
}

const pages: Record<string, PageComponent> = { Links, Empty, Many };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const page = (name: string, url: string): PageObject => ({ component: `app/${name}`, props: {}, url, version: null });
const respond = (body: PageObject) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });

let requests: { url: string; headers: Record<string, string> }[];
let root: Root;
let container: HTMLElement;
/** The elements the stub observer watches, and how it reports them. */
let watching: Set<Element>;
let report: (element: Element, ratio: number) => void;

beforeEach(() => {
  history.replaceState(null, '', '/a');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  requests = [];
  watching = new Set();
  let callback: (entries: { target: Element; isIntersecting: boolean; intersectionRatio: number }[]) => void = () => {};
  report = (element, ratio) => callback([{ target: element, isIntersecting: ratio > 0, intersectionRatio: ratio }]);
  (window as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    constructor(next: typeof callback) {
      callback = next;
    }
    observe(element: Element) {
      watching.add(element);
    }
    unobserve(element: Element) {
      watching.delete(element);
    }
    disconnect() {
      watching.clear();
    }
  };
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(input).replace(window.location.origin, '');
    requests.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    return respond(page('Empty', new URL(url, location.href).pathname));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
});

async function mount(initial: PageObject) {
  const Component = await resolve(initial.component);
  root = createRoot(container);
  await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} />));
}

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)!;
const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
/** The link scrolls into view, and stays. */
const scrollTo = (testId: string, ratio = 1) => act(async () => report($(testId), ratio));

describe('<Link prefetch="viewport">', () => {
  it('fetches the page once the link has been half in view for 250 ms — the click shows it without asking again', async () => {
    await mount(page('Links', '/a'));
    expect(requests).toEqual([]); // rendered, not in view
    await scrollTo('view');
    await wait(100);
    expect(requests).toEqual([]);
    await wait(200);
    expect(requests.map((request) => request.url)).toEqual(['/in-view']);
    expect(requests[0]!.headers).toMatchObject({ purpose: 'prefetch', [PAGE_HEADER]: PROTOCOL_VERSION });

    await act(async () => ($('view') as HTMLAnchorElement).click());
    await wait(10);
    expect(container.querySelector('[data-page="empty"]')).not.toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('a link that leaves the view within its dwell asks nothing', async () => {
    await mount(page('Links', '/a'));
    await scrollTo('view');
    await wait(100);
    await scrollTo('view', 0);
    await wait(300);
    expect(requests).toEqual([]);
  });

  it('works next to hover, with the link’s cacheForMs', async () => {
    await mount(page('Links', '/a'));
    await scrollTo('both');
    await wait(300);
    expect(requests.map((request) => request.url)).toEqual(['/both']);
  });

  it('never watches a partial reload, an action, another site, or a link without it', async () => {
    await mount(page('Links', '/a'));
    await wait(10);
    expect([...watching].map((element) => element.getAttribute('data-testid')).sort()).toEqual(['both', 'view']);
  });

  it('stops watching when the link unmounts', async () => {
    await mount(page('Links', '/a'));
    await wait(10);
    expect(watching.size).toBe(2);
    await act(async () => root.unmount());
    expect(watching.size).toBe(0);
    root = createRoot(document.createElement('div')); // for afterEach
  });

  it('50 visible links: at most 20 requests, two at a time', async () => {
    let underWay = 0;
    let most = 0;
    vi.mocked(window.fetch).mockImplementation(async (input, init = {}) => {
      const url = String(input).replace(window.location.origin, '');
      requests.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      underWay++;
      most = Math.max(most, underWay);
      await new Promise((resolve) => setTimeout(resolve, 20));
      underWay--;
      return respond(page('Empty', url));
    });
    await mount(page('Many', '/a'));
    await act(async () => {
      for (let index = 0; index < 50; index++) report($(`item-${index}`), 1);
    });
    await wait(1500);
    expect(requests).toHaveLength(20);
    expect(most).toBe(2);
  });
});

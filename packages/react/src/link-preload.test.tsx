// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { loadHistoryFallback } from '@marmeon/http/client/adapter';
import type { RouteManifest } from '@marmeon/http/page';
import type { PageObject } from '@marmeon/http/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp } from './app.tsx';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';

const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routes: RouteManifest = {
  'feature.show': { method: 'get', path: '/feature', view: 'app/Feature' },
  'feature.save': { method: 'post', path: '/feature' },
  'feature.other': { method: 'get', path: '/other', view: 'app/Other' },
};

// Without the app's generated `Routes` every route name is a plain string, which is no GET route to the types: the web app's type tests check `preload` on typed routes.
const preloads = (preload: true | 'mount' | 'viewport') => ({ preload }) as unknown as Record<string, never>;

function Links() {
  return (
    <nav>
      <Link route="feature.show" {...preloads('mount')} data-testid="mount">
        Mount
      </Link>
      <Link route="feature.other" {...preloads(true)} data-testid="hover">
        Hover
      </Link>
      <Link route="feature.other" {...preloads('viewport')} data-testid="viewport">
        Viewport
      </Link>
      <Link href="/feature" preload="mount" data-testid="href">
        By href
      </Link>
      {/* @ts-expect-error — an action is never preloaded: Type '"mount"' is not assignable to type 'undefined'. */}
      <Link href="/feature" method="post" preload="mount" data-testid="post">
        Save
      </Link>
    </nav>
  );
}

const Feature: PageComponent = () => <p>feature</p>;
const Other: PageComponent = () => <p>other</p>;

const modules = { Links, Feature, Other } as Record<string, PageComponent>;
const resolveModules = resolveModulePages(Object.fromEntries(Object.entries(modules).map(([name, view]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: view })])));
const resolve = vi.fn(resolveModules) as unknown as typeof resolveModules;
const page = (name: string, url: string): PageObject => ({ component: `app/${name}`, props: {}, url, version: null });

let root: Root;
let container: HTMLElement;
let watching: Set<Element>;
let report: (element: Element, ratio: number) => void;
const fetches = () => vi.mocked(window.fetch).mock.calls.length;
const resolved = (name: string) => vi.mocked(resolve).mock.calls.filter(([component]) => component === name).length;

beforeEach(() => {
  history.replaceState(null, '', '/a');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  vi.mocked(resolve).mockClear();
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
  vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
});

async function mount() {
  const initial = page('Links', '/a');
  const Component = await resolveModules(initial.component);
  root = createRoot(container);
  await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} routes={routes} />));
}

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)!;
const wait = (ms: number) => act(async () => void (await new Promise((done) => setTimeout(done, ms))));

describe('<Link preload>', () => {
  it('says once in development that a link by href has nothing to preload (the first render of the file)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();
    await wait(10);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('<Link preload> does nothing'))).toHaveLength(1);
  });

  it('mount loads the code of the target view once, and asks the server nothing', async () => {
    await mount();
    await wait(10);
    expect(resolved('app/Feature')).toBe(1);
    expect(fetches()).toBe(0);
  });

  it('hover loads the code after the pointer rests, never before, and asks nothing', async () => {
    await mount();
    await wait(10);
    expect(resolved('app/Other')).toBe(0);
    await act(async () => $('hover').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await wait(120);
    expect(resolved('app/Other')).toBe(1);
    expect(fetches()).toBe(0);
  });

  it('viewport waits out the dwell of the observer, then loads the code and asks nothing', async () => {
    await mount();
    await wait(10);
    expect(watching.size).toBe(1);
    await act(async () => report($('viewport'), 1));
    await wait(100);
    expect(resolved('app/Other')).toBe(0);
    await wait(250);
    expect(resolved('app/Other')).toBe(1);
    expect(fetches()).toBe(0);
  });

  it('does nothing for a link by href or an action', async () => {
    await mount();
    await wait(10);
    // Only the link by route loads `app/Feature`; the one that is watched is the link in view.
    expect(resolved('app/Feature')).toBe(1);
    expect([...watching].map((element) => element.getAttribute('data-testid'))).toEqual(['viewport']);
  });
});

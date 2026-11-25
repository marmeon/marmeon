// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/about" }
/** The browser's side of the locale without a prefix: what the page's `urlLocales` does to actions, forms, islands, layers and `route()`. */
import type { RouteManifest } from '@marmeon/http/page';
import { PAGE_HEADER, PROTOCOL_VERSION, REGION_HEADER, type PageObject } from '@marmeon/http/protocol';
import { loadHistoryFallback } from '@marmeon/http/client/adapter';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp, useRouter, useStableUrlLocales } from './app.tsx';
import { Form } from './form.tsx';
import { Island } from './island.tsx';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { useRoute } from './routes.ts';
import { useAction } from './use-action.ts';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const urlLocales = { unprefixed: 'de', supported: ['en', 'de'] };

/** How many reloads `reloading({ islands: ['teaser'] })` finds: the island is where its route's page is. */
function Reloads() {
  const router = useRouter();
  const [found, setFound] = useState('none');
  return (
    <button type="button" data-testid="count" onClick={() => setFound(String(router.reloading({ islands: ['teaser'] }).length))}>
      {found}
    </button>
  );
}

/** The `route` functions About was given, one per render. */
const routeFunctions: unknown[] = [];

function About() {
  const store = useAction('notes.store');
  const route = useRoute();
  const router = useRouter();
  routeFunctions.push(route);
  return (
    <main>
      <Island route="teaser" fallback={<p>Loading…</p>} />
      <Reloads />
      <Link route="find" layer data-testid="open">Find</Link>
      <button type="button" data-testid="store" onClick={() => void store.submit({ data: {} })} />
      <Form route="search">
        <input name="q" defaultValue="ada" />
      </Form>
      <p data-testid="route">{route('about')}</p>
      <button type="button" data-testid="reload" onClick={() => void router.reload({ only: ['x'] })} />
    </main>
  );
}

function Teaser() {
  return <p data-testid="teaser">Teaser</p>;
}

function Find() {
  return (
    <section>
      <Island route="teaser" fallback={<p>Loading…</p>} />
      <Reloads />
    </section>
  );
}

const pages: Record<string, PageComponent> = { About, Teaser, Find };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, view]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: view })])));
const routes: RouteManifest = {
  about: { method: 'get', path: '/:locale/about', localized: true },
  teaser: { method: 'get', path: '/:locale/about/teaser', localized: true },
  find: { method: 'get', path: '/:locale/find', localized: true },
  search: { method: 'get', path: '/:locale/search', localized: true },
  'notes.store': { method: 'post', path: '/:locale/notes', localized: true },
};
const view = (name: string, url: string, extra: Partial<PageObject> = {}): PageObject => ({ component: `app/${name}`, props: {}, url, version: null, locale: 'de', ...extra });
const respond = (body: object, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, 'content-type': 'application/json', ...headers } });

let requests: { url: string; method: string }[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/about');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  requests = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(input).replace(window.location.origin, '');
    requests.push({ url, method: init.method ?? 'GET' });
    const { pathname } = new URL(url, location.href);
    if (pathname.endsWith('/teaser')) return respond(view('Teaser', pathname), { [REGION_HEADER]: 'island' });
    if (pathname.endsWith('/find')) return respond(view('Find', pathname, { layer: { key: 'app/Find', base: '/about' }, urlLocales }));
    return respond(view('About', pathname, { urlLocales }));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

async function mount(initial: PageObject) {
  const Component = await resolve(initial.component);
  root = createRoot(container);
  await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} routes={routes} />));
}

const $ = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
const wait = (ms = 20) => act(async () => void (await new Promise((done) => setTimeout(done, ms))));
async function until(assertion: () => void, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await wait(5);
    try {
      return assertion();
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
}
const click = (testId: string) => act(async () => $(testId).click());

describe('the page with urlLocales', () => {
  it('sends an action to the route at its address without a prefix', async () => {
    await mount(view('About', '/about', { urlLocales }));
    await click('store');
    await until(() => expect(requests.some((request) => request.method === 'POST')).toBe(true));
    expect(requests.filter((request) => request.method === 'POST').map((request) => request.url)).toEqual(['/notes']);
  });

  it('submits a GET form to the address without a prefix', async () => {
    await mount(view('About', '/about', { urlLocales }));
    await act(async () => void $('route').closest('main')!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(() => expect(requests.some((request) => request.url.startsWith('/search'))).toBe(true));
    expect(requests.find((request) => request.url.includes('search'))!.url).toBe('/search?q=ada');
  });

  it('builds route() and the action the old way without it', async () => {
    await mount(view('About', '/about'));
    expect($('route').textContent).toBe('/de/about');
    await click('store');
    await until(() => expect(requests.some((request) => request.method === 'POST')).toBe(true));
    expect(requests.find((request) => request.method === 'POST')!.url).toBe('/de/notes');
  });

  it('finds the island at its address without a prefix when it reloads', async () => {
    await mount(view('About', '/about', { urlLocales }));
    await until(() => expect(container.querySelector('[data-testid="teaser"]')).not.toBeNull());
    expect(requests.map((request) => request.url)).toContain('/about/teaser');
    await click('count');
    expect($('count').textContent).toBe('1');
  });

  it('finds none without it — the island is at /de/about/teaser there', async () => {
    await mount(view('About', '/about'));
    await until(() => expect(container.querySelector('[data-testid="teaser"]')).not.toBeNull());
    expect(requests.map((request) => request.url)).toContain('/de/about/teaser');
  });

  it('in a layer, reloads the islands of the layer’s own page: its urlLocales, not the page beneath’s', async () => {
    // The page beneath has none, the layer's page has: only the layer's own page tells where its island is.
    await mount(view('About', '/about'));
    await click('open');
    await until(() => expect(container.querySelector('section')).not.toBeNull());
    await until(() => expect(requests.map((request) => request.url)).toContain('/about/teaser'));
    await act(async () => container.querySelector<HTMLElement>('section [data-testid="count"]')!.click());
    expect(container.querySelector('section [data-testid="count"]')!.textContent).toBe('1');
  });
});

describe('useRoute', () => {
  it('stays the same function over a partial reload that brings the same urlLocales in a new page object', async () => {
    routeFunctions.length = 0;
    await mount(view('About', '/about', { urlLocales }));
    const before = requests.length;
    await click('reload');
    await until(() => expect(requests.length).toBeGreaterThan(before));
    await wait();
    expect(routeFunctions.length).toBeGreaterThan(1);
    expect(new Set(routeFunctions).size).toBe(1);
  });
});

describe('useStableUrlLocales', () => {
  it('gives the same object while a new page object carries the same locales, and a new one when they change', async () => {
    const seen: unknown[] = [];
    function Probe({ locales }: { locales: PageObject['urlLocales'] }) {
      seen.push(useStableUrlLocales(locales));
      return null;
    }
    root = createRoot(container);
    const render = (locales: PageObject['urlLocales']) => act(async () => root.render(<Probe locales={locales} />));
    await render({ unprefixed: 'de', supported: ['en', 'de'] });
    await render({ unprefixed: 'de', supported: ['en', 'de'] });
    expect(seen[1]).toBe(seen[0]);
    await render({ unprefixed: 'de', supported: ['en', 'de', 'fr'] });
    expect(seen[2]).not.toBe(seen[0]);
    await render(undefined);
    expect(seen[3]).toBeUndefined();
  });
});

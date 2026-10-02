// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/dashboard" }
import { PAGE_HEADER, REGION_HEADER, REGION_STATUS_HEADER, type PageObject, type RegionObject, type RouteManifest } from '@bespokecore/http/page';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BespokeApp } from './app.tsx';
import { Island, useIsland } from './island.tsx';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Dashboard() {
  return (
    <main>
      <Island route="sign-ins" query={{ limit: 5 }} fallback={<p data-testid="loading">Loading…</p>} />
      <Island route="members" fallback={<p>Loading…</p>} unauthorized={<p data-testid="hidden">Admins only.</p>} />
      <Island route="broken" fallback={<p>Loading…</p>} />
      <Link href="/people" data-testid="people">
        People
      </Link>
    </main>
  );
}

function SignIns({ entries }: { entries: string[] }) {
  const island = useIsland();
  return (
    <div data-testid="sign-ins">
      <span data-testid="entries">{entries.join(',')}</span>
      <span data-testid="range">{String(island.query.range)}</span>
      <button type="button" data-testid="week" onClick={() => void island.reload({ query: { range: '7d' } })}>
        7 days
      </button>
    </div>
  );
}

function Members({ count }: { count: number }) {
  return <p data-testid="members">{count}</p>;
}

function Thrower(): never {
  throw new Error('render failed');
}

function People() {
  return <p data-testid="people-page">People</p>;
}

function Outside() {
  useIsland();
  return null;
}

function Lazy() {
  return <Island route="sign-ins" load="visible" fallback={<p data-testid="lazy">Later…</p>} />;
}

const pages: Record<string, PageComponent> = { Dashboard, SignIns, Members, Thrower, People, Lazy, Outside };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`../modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const routes: RouteManifest = {
  'sign-ins': { method: 'get', path: '/islands/sign-ins' },
  members: { method: 'get', path: '/islands/members' },
  broken: { method: 'get', path: '/islands/broken' },
};
const page = (name: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ component: `app/${name}`, props, url, version: null });
const island = (name: string, url: string, props: Record<string, unknown>, extra: Partial<RegionObject> = {}): RegionObject => ({
  component: `app/${name}`,
  props,
  url,
  version: null,
  ...extra,
});
const respond = (body: object, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: 'true', ...headers } });

let server: (url: string, init: RequestInit) => Response | Promise<Response>;
let requests: { url: string; headers: Record<string, string> }[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/dashboard');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  requests = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    requests.push({ url: String(input), headers: { ...(init.headers as Record<string, string>) } });
    return server(String(input), init);
  });
  server = (url) => {
    const { pathname, searchParams } = new URL(url, location.href);
    if (pathname === '/islands/sign-ins') {
      const range = searchParams.get('range') ?? '30d';
      return respond(island('SignIns', pathname, { entries: [`ada:${range}`] }, { query: Object.fromEntries(searchParams), queryDefaults: { range: '30d', limit: 5 } }), { [REGION_HEADER]: 'island' });
    }
    if (pathname === '/islands/members') return new Response(null, { status: 204, headers: { [REGION_STATUS_HEADER]: 'forbidden' } });
    if (pathname === '/islands/broken') return respond(island('Thrower', pathname, {}), { [REGION_HEADER]: 'island' });
    if (pathname === '/people') return respond(page('People', '/people'));
    return new Response('not found', { status: 404 });
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

async function mount(initial: PageObject) {
  const Component = await resolve(initial.component);
  root = createRoot(container);
  await act(async () => root.render(<BespokeApp initialPage={initial} initialComponent={Component} resolve={resolve} routes={routes} />));
}

const $ = (selector: string) => container.querySelector(selector);
const wait = (ms = 10) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const islandRequests = () => requests.filter((request) => request.headers[REGION_HEADER] === 'island');

describe('<Island> and useIsland (E48, E51)', () => {
  it('renders its fallback, then the island — each island its own request, in parallel, after the page', async () => {
    await mount(page('Dashboard', '/dashboard'));
    expect($('[data-island="sign-ins"]')?.getAttribute('data-status')).not.toBeNull();
    await wait();
    expect($('[data-testid="entries"]')!.textContent).toBe('ada:30d');
    expect(islandRequests().map((request) => request.url).sort()).toEqual(['/islands/broken', '/islands/members', '/islands/sign-ins?limit=5']);
    expect($('[data-island="sign-ins"]')!.getAttribute('data-status')).toBe('ready');
  });

  it('counter-check: a forbidden island shows `unauthorized`, a failing one its error — the page and the others stay', async () => {
    await mount(page('Dashboard', '/dashboard'));
    await wait();
    expect($('[data-testid="hidden"]')!.textContent).toBe('Admins only.');
    expect($('[data-island="members"]')!.getAttribute('data-status')).toBe('forbidden');
    // The broken one threw while rendering: its own error, not the page's.
    expect($('[data-island="broken"] [data-bespoke-failure="island"]')).not.toBeNull();
    expect($('[data-testid="entries"]')!.textContent).toBe('ada:30d');
    expect(location.pathname).toBe('/dashboard');
  });

  it('reload({ query }) reloads only its island — with the typed query in its URL', async () => {
    await mount(page('Dashboard', '/dashboard'));
    await wait();
    const before = requests.length;
    await act(async () => ($('[data-testid="week"]') as HTMLButtonElement).click());
    await wait();
    expect(requests.slice(before).map((request) => request.url)).toEqual(['/islands/sign-ins?range=7d&limit=5']);
    expect($('[data-testid="entries"]')!.textContent).toBe('ada:7d');
    expect($('[data-testid="range"]')!.textContent).toBe('7d');
  });

  it('counter-check: Back shows the islands from memory — no request, the reloaded query kept', async () => {
    await mount(page('Dashboard', '/dashboard'));
    await wait();
    await act(async () => ($('[data-testid="week"]') as HTMLButtonElement).click());
    await wait();
    await act(async () => ($('[data-testid="people"]') as HTMLAnchorElement).click());
    await wait();
    expect($('[data-testid="people-page"]')).not.toBeNull();
    const before = requests.length;
    await act(async () => history.back());
    await wait(30);
    expect($('[data-testid="entries"]')!.textContent).toBe('ada:7d');
    expect($('[data-testid="loading"]')).toBeNull();
    // The forbidden one too: memory keeps that it was (not what it would have shown).
    expect($('[data-testid="hidden"]')).not.toBeNull();
    expect(requests.length).toBe(before);
    expect(JSON.stringify(history.state)).not.toContain('ada:');
  });

  it('load="visible" waits until it scrolls into view', async () => {
    let observed: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          observed = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    await mount(page('Lazy', '/dashboard'));
    await wait();
    expect(islandRequests()).toEqual([]);
    expect($('[data-testid="lazy"]')).not.toBeNull();
    await act(async () => observed!([{ isIntersecting: true }]));
    await wait();
    expect(islandRequests().map((request) => request.url)).toEqual(['/islands/sign-ins']);
    expect($('[data-testid="entries"]')!.textContent).toBe('ada:30d');
    vi.unstubAllGlobals();
  });

  it('useIsland outside an island says where it belongs', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount(page('Outside', '/dashboard'));
    expect(container.textContent).toContain('useIsland() is for the view of an island');
    errors.mockRestore();
  });
});

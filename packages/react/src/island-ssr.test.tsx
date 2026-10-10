// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/dashboard" }
import { PAGE_SCRIPT_ID, scriptJson, type DeferredResult, type PageObject, type RegionResult, type RouteManifest } from '@marmeon/http/page';
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePage } from './app.tsx';
import { createMarmeonApp } from './client.tsx';
import { Deferred } from './deferred.tsx';
import { Head } from './head.tsx';
import { Island, useIsland } from './island.tsx';
import { resolveModulePages } from './pages.ts';
import { createSsrRenderer } from './server.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Dashboard() {
  return (
    <main>
      <h1>Dashboard</h1>
      <Island route="sign-ins" query={{ limit: 5 }} fallback={<p data-testid="loading">Loading…</p>} />
      <Island route="members" fallback={<p>Loading…</p>} unauthorized={<p data-testid="hidden">Admins only.</p>} />
      <Island route="broken" fallback={<p>Loading…</p>} error={<p data-testid="broken">Broken.</p>} />
      <Island route="stale" fallback={<p data-testid="stale-loading">Loading…</p>} />
    </main>
  );
}

function SignIns({ entries }: { entries: string[] }) {
  const island = useIsland();
  return (
    <div data-testid="sign-ins">
      <span data-testid="entries">{entries.join(',')}</span>
      <span data-testid="range">{String(island.query.range)}</span>
    </div>
  );
}

function Members({ count }: { count: number }) {
  return <p data-testid="members">{count}</p>;
}

/** A page with state of its own beside an island — a click re-renders it while the island may still be streaming. */
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <button type="button" data-testid="count" onClick={() => setCount((value) => value + 1)}>
        {count}
      </button>
      <Island route="sign-ins" query={{ limit: 5 }} fallback={<p data-testid="loading">Loading…</p>} />
    </main>
  );
}

function Titled() {
  return (
    <>
      <Head title="From an island" />
      <p>titled</p>
    </>
  );
}

function WithHead() {
  return <Island route="titled" fallback={<p>Loading…</p>} error={<p data-testid="refused">Refused.</p>} />;
}

function Profile({ name, activity }: { name: string; activity?: string[] }) {
  const { props } = usePage<{ activity?: string[] }>();
  return (
    <main>
      <h1>{name}</h1>
      <Deferred data="activity" fallback={<p data-testid="activity-loading">Loading…</p>}>
        {() => <p data-testid="activity">{(activity ?? props.activity)!.join(',')}</p>}
      </Deferred>
    </main>
  );
}

const resolve = resolveModulePages(
  Object.fromEntries(
    Object.entries({ Dashboard, SignIns, Members, Titled, WithHead, Profile, Counter }).map(([name, page]) => [`../modules/app/views/${name}.tsx`, async () => ({ default: page })]),
  ),
);
const routes: RouteManifest = {
  'sign-ins': { method: 'get', path: '/islands/sign-ins' },
  members: { method: 'get', path: '/islands/members' },
  broken: { method: 'get', path: '/islands/broken' },
  stale: { method: 'get', path: '/islands/stale' },
  titled: { method: 'get', path: '/islands/titled' },
};

/** What the server's request resolves for each island URL — in-process, no HTTP. */
const resolved: Record<string, RegionResult> = {
  '/islands/sign-ins?limit=5': {
    status: 'ready',
    region: { component: 'app/SignIns', props: { entries: ['ada', 'alan'] }, url: '/islands/sign-ins?limit=5', version: null, query: { limit: 5 }, queryDefaults: { range: '30d', limit: 5 } },
  },
  '/islands/members': { status: 'forbidden' },
  '/islands/broken': { status: 'exception', failure: { status: 500 } },
  '/islands/stale': { status: 'browser' },
  '/islands/titled': { status: 'ready', region: { component: 'app/Titled', props: {}, url: '/islands/titled', version: null } },
};

let asked: string[];
const resolveIsland = async (url: string): Promise<RegionResult> => {
  asked.push(url);
  return resolved[url] ?? { status: 'exception', failure: { status: 404 } };
};

/** The document as the server sends it — the page object in the head, the markup (all boundaries complete) in `#app`. */
async function serve(page: PageObject, options: { resolveDeferred?: (group: string) => Promise<DeferredResult | null>; complete?: boolean } = {}) {
  const result = await createSsrRenderer(resolve, { routes })(page, { complete: options.complete ?? true, resolveIsland, resolveDeferred: options.resolveDeferred });
  const html = await new Response(result.html).text();
  const sent = result.streamedProps ? { ...page, streamedProps: result.streamedProps } : page;
  document.head.innerHTML = `<script type="application/json" id="${PAGE_SCRIPT_ID}">${scriptJson(sent)}</script>`;
  document.body.innerHTML = `<div id="app">${html}</div>`;
  // React's streaming runtime (inline scripts that move late boundaries into place): innerHTML does not run scripts.
  for (const script of [...document.querySelectorAll('#app script:not([type])')]) new Function(script.textContent ?? '')();
  return html;
}

let requests: string[];
beforeEach(() => {
  asked = [];
  requests = [];
  history.replaceState(null, '', '/dashboard');
  vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
    requests.push(String(input));
    if (String(input).startsWith('/islands/stale')) {
      return new Response(JSON.stringify({ component: 'app/Members', props: { count: 3 }, url: '/islands/stale', version: null }), {
        headers: { 'x-marmeon': 'true', 'x-marmeon-region': 'island' },
      });
    }
    return new Response(JSON.stringify({ component: 'app/Profile', props: { activity: ['fetched'] }, url: '/users/1', version: null }), { headers: { 'x-marmeon': 'true' } });
  });
});
afterEach(() => vi.restoreAllMocks());

const reported = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([message]) => !String(message).includes('multiple renderers'));
const $ = (selector: string) => document.querySelector(selector);

async function start() {
  await act(async () => {
    await createMarmeonApp({ resolve, routes });
    await new Promise((done) => setTimeout(done, 30));
  });
}

/** React reveals streamed boundaries in batches (up to ~300 ms after the last one) — wait for that, then for what follows. */
const revealed = () => act(async () => void (await new Promise((done) => setTimeout(done, 350))));

describe('islands in the SSR stream', () => {
  it('renders each island in the HTML with its data — the outcome only for a refused one', async () => {
    const html = await serve({ component: 'app/Dashboard', props: {}, url: '/dashboard', version: null });
    expect(asked.sort()).toEqual(['/islands/broken', '/islands/members', '/islands/sign-ins?limit=5', '/islands/stale']);
    expect($('[data-island="sign-ins"]')!.getAttribute('data-status')).toBe('ready');
    expect($('[data-testid="entries"]')!.textContent).toBe('ada,alan');
    expect($('[data-testid="range"]')!.textContent).toBe('30d');
    expect($('[data-testid="hidden"]')).not.toBeNull();
    expect($('[data-testid="broken"]')).not.toBeNull();
    // Left to the browser: its fallback, and no data block.
    expect($('[data-testid="stale-loading"]')).not.toBeNull();
    const blocks = [...document.querySelectorAll('script[type="application/json"][id^="marmeon-island-"]')].map((script) => JSON.parse(script.textContent!));
    expect(blocks).toContainEqual({ status: 'forbidden' });
    expect(blocks.map((block) => block.status).sort()).toEqual(['exception', 'forbidden', 'ready']);
    expect(html).not.toContain('"count"');
  });

  it('hydrates the islands without a mismatch and without a request — only the one the server left to the browser loads', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await serve({ component: 'app/Dashboard', props: {}, url: '/dashboard', version: null });
    await start();
    expect(reported(errors)).toEqual([]);
    expect($('[data-marmeon-hydration]')).toBeNull();
    expect($('[data-testid="entries"]')!.textContent).toBe('ada,alan');
    expect($('[data-testid="hidden"]')).not.toBeNull();
    expect(requests).toEqual(['/islands/stale']);
    expect($('[data-island="stale"]')!.getAttribute('data-status')).toBe('ready');
  });

  it('without the data blocks every island is a request of its own after hydrating', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await serve({ component: 'app/Dashboard', props: {}, url: '/dashboard', version: null });
    for (const script of [...document.querySelectorAll('script[id^="marmeon-island-"]')]) script.remove();
    await start();
    expect(requests.map((url) => url.split('?')[0]).sort()).toEqual(['/islands/broken', '/islands/members', '/islands/sign-ins', '/islands/stale']);
  });

  it('a re-render of the page while an island still streams does not make the browser load it again', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page: PageObject = { component: 'app/Counter', props: {}, url: '/dashboard', version: null };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const result = await createSsrRenderer(resolve, { routes })(page, {
      resolveIsland: async (url) => {
        await held;
        return resolveIsland(url);
      },
    });
    const reader = (result.html as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    // The shell first, the island's boundary still pending; then the rest — all read before the browser side starts
    // (React does not allow its server and browser renderers to run at the same time in one process).
    const shell = decoder.decode((await reader.read()).value);
    release();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    // The document so far: only the shell has arrived — and it is still loading (React fails a pending boundary of a
    // document that has finished loading: its server will never complete it).
    let readyState: DocumentReadyState = 'loading';
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => readyState });
    document.head.innerHTML = `<script type="application/json" id="${PAGE_SCRIPT_ID}">${scriptJson(page)}</script>`;
    document.body.innerHTML = `<div id="app">${shell}</div>`;
    expect($('[data-testid="loading"]')).not.toBeNull();
    await start();
    await act(async () => ($('[data-testid="count"]') as HTMLButtonElement).click());
    expect($('[data-testid="count"]')!.textContent).toBe('1');
    // The rest of the stream arrives: the island with its data.
    $('#app')!.insertAdjacentHTML('beforeend', rest);
    for (const script of [...document.querySelectorAll('#app script:not([type])')]) new Function(script.textContent ?? '')();
    readyState = 'interactive';
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await revealed();
    delete (document as { readyState?: unknown }).readyState;
    expect($('[data-testid="entries"]')?.textContent).toBe('ada,alan');
    expect(requests).toEqual([]);
    expect(reported(errors)).toEqual([]);
  });

  it('refuses a <Head> in an island (development): its error, not the page title', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await serve({ component: 'app/WithHead', props: {}, url: '/dashboard', version: null });
    await start();
    expect($('[data-testid="refused"]')).not.toBeNull();
    expect(document.title).not.toContain('From an island');
    expect(errors.mock.calls.flat().map(String).join('\n')).toContain('<Head> in island [app/Titled] — islands cannot change the document head; set it on the page.');
  });
});

describe('deferred props in the SSR stream', () => {
  const profile: PageObject = { component: 'app/Profile', props: { name: 'Ada' }, url: '/users/1', version: null, deferredProps: { default: ['activity'] } };

  it('streams the group with the page and lands it without a request', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await serve(profile, { complete: false, resolveDeferred: async () => ({ props: { activity: ['signed in'] } }) });
    expect(JSON.parse($(`#${PAGE_SCRIPT_ID}`)!.textContent!).streamedProps).toEqual(['default']);
    await start();
    await revealed();
    expect($('[data-testid="activity"]')?.textContent).toBe('signed in');
    expect(requests).toEqual([]);
    expect(reported(errors)).toEqual([]);
  });

  it('without streamedProps the browser asks for the group', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await serve(profile, { complete: false });
    expect(JSON.parse($(`#${PAGE_SCRIPT_ID}`)!.textContent!).streamedProps).toBeUndefined();
    await start();
    expect(requests).toEqual(['/users/1']);
    expect($('[data-testid="activity"]')?.textContent).toBe('fetched');
  });

  it('asks for a group the server could not stream', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await serve(profile, { complete: false, resolveDeferred: async () => null });
    await start();
    await revealed();
    expect(requests).toEqual(['/users/1']);
    expect($('[data-testid="activity"]')?.textContent).toBe('fetched');
  });
});

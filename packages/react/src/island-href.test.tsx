// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/dashboard" }
import type { RegionResult, RouteManifest } from '@marmeon/http/page';
import { scriptJson } from '@marmeon/http/client/adapter';
import { PAGE_HEADER, PAGE_SCRIPT_ID, PROTOCOL_VERSION, REGION_HEADER, sitePath, type PageObject } from '@marmeon/http/protocol';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarmeonApp } from './client.tsx';
import { Island, useIsland } from './island.tsx';
import { resolveModulePages } from './pages.ts';
import { createSsrRenderer } from './server.tsx';
import { until } from './test-helpers/settle.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The URLs a server could hand a page: the island routes it chose, and everything an attacker would try instead. */
const REFUSED = [
  'https://evil.example/islands/members',
  'http://evil.example/islands/members',
  '//evil.example/islands/members',
  '///evil.example/islands/members',
  '/\\evil.example/islands/members',
  '\\\\evil.example/islands/members',
  '\\/evil.example',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<p>x</p>',
  'mailto:ada@example.com',
  'islands/members',
  './islands/members',
  '',
  ' /islands/members',
  ' //evil.example',
  '/\t/evil.example',
  '/\n/evil.example',
  '/islands/members\n',
  '/islands/\u0000members',
  '/islands/a b',
  '/a/..//evil.example/islands/members',
  '/a/%2e%2e//evil.example',
  '/..//evil.example',
];

function Panels({ urls }: { urls: unknown[] }) {
  return (
    <main>
      {urls.map((url, index) => (
        <Island key={index} href={url as string} fallback={<p data-testid="loading">Loading…</p>} error={<p data-testid="refused">Refused.</p>} />
      ))}
    </main>
  );
}

function Members({ count }: { count: number }) {
  const island = useIsland();
  return (
    <p data-testid="members" data-query={JSON.stringify(island.query)}>
      {count}
    </p>
  );
}

function Home() {
  return <p>home</p>;
}

const resolve = resolveModulePages(Object.fromEntries(Object.entries({ Panels, Members, Home }).map(([name, view]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: view })])));
const routes: RouteManifest = {};
const page = (urls: unknown[]): PageObject => ({ component: 'app/Panels', props: { urls }, url: '/dashboard', version: null });

/** What the server resolves for the island URLs it knows — in-process, no HTTP. */
const resolved: Record<string, RegionResult> = {
  '/dashboard/islands/members': { status: 'ready', region: { component: 'app/Members', props: { count: 3 }, url: '/dashboard/islands/members', version: null } },
  '/dashboard/islands/members?limit=3': {
    status: 'ready',
    region: { component: 'app/Members', props: { count: 3 }, url: '/dashboard/islands/members', version: null, query: { limit: 3 }, queryDefaults: { limit: 5 } },
  },
  '/dashboard': { status: 'exception', failure: { status: 404 } },
};

let asked: string[];
const resolveIsland = async (url: string): Promise<RegionResult> => {
  asked.push(url);
  return resolved[url] ?? { status: 'exception', failure: { status: 404 } };
};

let requests: string[];
beforeEach(() => {
  asked = [];
  requests = [];
  history.replaceState(null, '', '/dashboard');
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(input).replace(window.location.origin, '');
    // Island requests only: a page that failed to render may be fetched again, which is not what is counted here.
    if ((init.headers as Record<string, string> | undefined)?.[REGION_HEADER] === 'island') requests.push(url);
    if (url === '/dashboard') return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ component: 'app/Members', props: { count: 3 }, url: '/dashboard/islands/members', version: null }), {
      headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [REGION_HEADER]: 'island' },
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const $ = (selector: string) => document.querySelector(selector);

/** The document as the server sends it, put into the happy-dom page. */
async function serve(object: PageObject) {
  const result = await createSsrRenderer(resolve, { routes })(object, { complete: true, resolveIsland });
  const html = await new Response(result.html).text();
  document.head.innerHTML = `<script type="application/json" id="${PAGE_SCRIPT_ID}">${scriptJson(object)}</script>`;
  document.body.innerHTML = `<div id="app">${html}</div>`;
  return html;
}

async function start() {
  await act(async () => {
    await createMarmeonApp({ resolve, routes });
  });
}

describe('sitePath', () => {
  it('takes a path of this site, query kept and fragment dropped', () => {
    expect(sitePath('/dashboard/islands/members')).toBe('/dashboard/islands/members');
    expect(sitePath('/dashboard/islands/members?limit=3&range=7d')).toBe('/dashboard/islands/members?limit=3&range=7d');
    expect(sitePath('/islands/a%20b?x=http://evil.example')).toBe('/islands/a%20b?x=http://evil.example');
    expect(sitePath('/a/../islands/members#top')).toBe('/islands/members');
  });

  it.each(REFUSED)('refuses %j', (href) => {
    expect(sitePath(href)).toBeUndefined();
  });

  it.each([undefined, null, 7, {}, ['/islands/members']])('refuses what is no string: %j', (href) => {
    expect(sitePath(href)).toBeUndefined();
  });
});

describe('<Island href> on the server', () => {
  it('renders the island of an href with its data, and asks the server for exactly that path', async () => {
    const html = await serve(page(['/dashboard/islands/members?limit=3']));
    expect(asked).toEqual(['/dashboard/islands/members?limit=3']);
    expect($('[data-island="/dashboard/islands/members"]')!.getAttribute('data-status')).toBe('ready');
    expect($('[data-testid="members"]')!.textContent).toBe('3');
    expect($('[data-testid="members"]')!.getAttribute('data-query')).toBe('{"limit":3}');
    expect(html).toContain('marmeon-island-');
  });

  it.each(REFUSED)('throws for %j before it asks the server for anything', async (href) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(createSsrRenderer(resolve, { routes })(page([href]), { complete: true, resolveIsland }).then((result) => new Response(result.html).text())).rejects.toThrow(/\[marmeon:R21\]/);
    expect(asked).toEqual([]);
  });

  it('in production shows the island’s error and asks for nothing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await serve(page(['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', '/a/..//evil.example']));
    expect(asked).toEqual([]);
    expect(document.querySelectorAll('[data-testid="refused"]')).toHaveLength(5);
    expect(document.querySelectorAll('[data-island="refused"]')).toHaveLength(5);
    expect(document.body.innerHTML).not.toContain('evil.example');
  });

  it('a route that is no island (the server answers 404) is the island’s error state', async () => {
    await serve(page(['/dashboard']));
    expect(asked).toEqual(['/dashboard']);
    expect($('[data-island="/dashboard"]')!.getAttribute('data-status')).toBe('exception');
    expect($('[data-testid="refused"]')).not.toBeNull();
  });
});

describe('<Island href> in the browser', () => {
  it('hydrates what the server rendered, without a mismatch and without a request', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await serve(page(['/dashboard/islands/members?limit=3']));
    const markup = $('#app')!.innerHTML;
    await start();
    await until(() => expect($('[data-testid="members"]')).not.toBeNull());
    expect(errors.mock.calls.filter(([message]) => !String(message).includes('multiple renderers'))).toEqual([]);
    expect($('[data-marmeon-hydration]')).toBeNull();
    expect(requests).toEqual([]);
    expect($('#app')!.innerHTML).toBe(markup);
    expect($('[data-testid="members"]')!.getAttribute('data-query')).toBe('{"limit":3}');
  });

  it('loads the island of an href in the browser when the server left it out', async () => {
    await serve(page(['/dashboard/islands/members']));
    for (const script of [...document.querySelectorAll('script[id^="marmeon-island-"]')]) script.remove();
    await start();
    await until(() => expect(requests).toEqual(['/dashboard/islands/members']));
    await until(() => expect($('[data-island="/dashboard/islands/members"]')!.getAttribute('data-status')).toBe('ready'));
  });

  it('an href that is no island (a 404) is the error state — one request, the page stays', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await serve(page(['/dashboard']));
    for (const script of [...document.querySelectorAll('script[id^="marmeon-island-"]')]) script.remove();
    await start();
    await until(() => expect($('[data-testid="refused"]')).not.toBeNull());
    expect(requests).toEqual(['/dashboard']);
  });

  it('an href that answers a success without being an island shows the error state, with nothing of the body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(window.fetch).mockImplementation(async (input) => {
      requests.push(String(input).replace(window.location.origin, ''));
      return new Response(JSON.stringify({ message: 'internal status text', users: 12 }), { headers: { 'content-type': 'application/json' } });
    });
    await serve(page(['/api/status']));
    for (const script of [...document.querySelectorAll('script[id^="marmeon-island-"]')]) script.remove();
    await start();
    await until(() => expect($('[data-island="/api/status"]')!.getAttribute('data-status')).toBe('exception'));
    expect(requests).toEqual(['/api/status']);
    expect(document.body.innerHTML).not.toContain('internal status text');
    expect($('[data-testid="refused"]')).not.toBeNull();
  });

  it.each(REFUSED)('sends no request for %j', async (href) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The server rendered the page with nothing for it (a hostile or broken value arrives with the page object).
    document.head.innerHTML = `<script type="application/json" id="${PAGE_SCRIPT_ID}">${scriptJson(page([href]))}</script>`;
    document.body.innerHTML = '<div id="app"></div>';
    await start().catch(() => undefined);
    await act(async () => void (await new Promise((done) => setTimeout(done, 20))));
    expect(requests).toEqual([]);
  });

  it('in production an href that is no path of this site is the error state and sends no request', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    document.head.innerHTML = `<script type="application/json" id="${PAGE_SCRIPT_ID}">${scriptJson(page(['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', '/dashboard/islands/members']))}</script>`;
    document.body.innerHTML = '<div id="app"></div>';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await start();
    await until(() => expect(document.querySelectorAll('[data-testid="refused"]')).toHaveLength(4));
    // The one good href is the control: it is the only request.
    await until(() => expect(requests).toEqual(['/dashboard/islands/members']));
  });
});

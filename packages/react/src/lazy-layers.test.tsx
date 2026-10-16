// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1" }
import type { RouteManifest } from '@marmeon/http/page';
import { PAGE_HEADER, PAGE_SCRIPT_ID, type PageObject } from '@marmeon/http/protocol';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.

/**
 * Layers as a chunk of their own: the core loads them — with the React layer stack, one round trip —
 * when the server answers with a layer and nothing loaded them; `<Link layer>` loads them where it renders; a deep link's
 * document hydrates with them. Each test starts from fresh modules: nothing of the layer code is loaded yet, as in a tab
 * that just opened the app.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The adapter as a fresh tab has it — and views made with its own hooks (contexts are per module instance). */
async function freshApp() {
  const [{ MarmeonApp, useRouter }, { createMarmeonApp }, { createSsrRenderer }, { Link }, { useLayer }, { resolveModulePages }] = await Promise.all([
    import('./app.tsx'),
    import('./client.tsx'),
    import('./server.tsx'),
    import('./link.tsx'),
    import('./layer.tsx'),
    import('./pages.ts'),
  ]);
  function Profile({ name }: { name: string }) {
    const router = useRouter();
    return (
      <main>
        <h1 data-testid="name">{name}</h1>
        {/* A plain visit the server answers with a layer (it may, to any visit) — no `<Link layer>` on the page. */}
        <button type="button" data-testid="plain" onClick={() => void router.visit('/users/1/edit')}>
          Edit
        </button>
      </main>
    );
  }
  function Linked() {
    return (
      <Link route="edit" layer data-testid="edit">
        Edit
      </Link>
    );
  }
  function Edit({ name }: { name: string }) {
    const layer = useLayer();
    return (
      <section>
        <h2>Edit {name}</h2>
        <span data-testid="depth">{layer.depth}</span>
        <button type="button" data-testid="close" onClick={() => void layer.close()}>
          Cancel
        </button>
      </section>
    );
  }
  const views = { Profile, Linked, Edit };
  const resolve = resolveModulePages(Object.fromEntries(Object.entries(views).map(([name, view]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: view })])));
  return { MarmeonApp, createMarmeonApp, createSsrRenderer, resolve };
}

const routes: RouteManifest = { edit: { method: 'get', path: '/users/1/edit' } };
const page = (name: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ component: `app/${name}`, props, url, version: null });
const layer = (name: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ ...page(name, url, props), layer: { key: `app/${name}`, base: '/users/1' } });

let root: Root | undefined;
let info: { mock: { calls: unknown[][] } };

beforeEach(() => {
  vi.resetModules();
  history.replaceState(null, '', '/users/1');
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="app"></div>';
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(window, 'fetch').mockImplementation(async () => new Response(JSON.stringify(layer('Edit', '/users/1/edit', { name: 'Ada' })), { headers: { [PAGE_HEADER]: 'true' } }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.restoreAllMocks();
});

const $ = (selector: string) => document.querySelector(selector);
const dialogs = () => [...document.querySelectorAll('dialog[data-marmeon-layer]')];
const wait = (ms = 20) => act(async () => void (await new Promise((done) => setTimeout(done, ms))));
const click = (selector: string) => act(async () => ($(selector) as HTMLElement).click());
/** The development hint that the layers loaded only once the server answered with one. */
const loadedLate = () => info.mock.calls.filter(([message]) => String(message).includes('[marmeon:C7]'));

async function mount(initial: PageObject) {
  const { MarmeonApp, resolve } = await freshApp();
  const { createRoot } = await import('react-dom/client');
  // From the same fresh modules as the app: a feature of another copy of the core is none of this navigator's.
  const { loadHistoryFallback } = await import('@marmeon/http/client/adapter');
  const HISTORY = [await loadHistoryFallback()];
  const Component = await resolve(initial.component);
  root = createRoot($('#app')!);
  await act(async () => root!.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} routes={routes} />));
}

describe('layers loaded on demand in React', () => {
  it('a plain visit answered with a layer: the layers and their stack load then — the layer opens over the page, Back closes it', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    const heading = $('[data-testid="name"]');
    await click('[data-testid="plain"]');
    // The layers' code loads now (fresh modules) — under a busy test run, that may take more than a tick.
    for (let tries = 0; tries < 100 && dialogs().length === 0; tries++) await wait(10);
    expect(loadedLate()).toHaveLength(1);
    expect(dialogs()).toHaveLength(1);
    expect($('[data-testid="depth"]')!.textContent).toBe('1');
    // Not shown as a page: the page beneath is the same element.
    expect($('[data-testid="name"]')).toBe(heading);
    expect(location.pathname).toBe('/users/1/edit');

    await act(async () => history.back());
    await wait(40);
    expect(dialogs()).toEqual([]);
    expect(location.pathname).toBe('/users/1');
  });

  it('<Link layer> loads them where it renders — they are here before the click, which waits for nothing', async () => {
    await mount(page('Linked', '/users/1'));
    await wait();
    // Here before the click: the stack (with the core's layers) has loaded already — asking for it again finds it settled.
    const stack = (await import('./app.tsx')).loadLayerStack() as Promise<unknown> & { status?: string };
    expect(stack.status).toBe('fulfilled');
    await click('[data-testid="edit"]');
    await wait();
    expect(dialogs()).toHaveLength(1);
    expect(loadedLate()).toEqual([]);
  });

  it('a deep link’s document hydrates with its layers: the stack loads before hydrating — no mismatch, the layer works', async () => {
    const document_ = { ...page('Profile', '/users/1', { name: 'Ada' }), layers: [layer('Edit', '/users/1/edit', { name: 'Ada' })] };
    // The server's markup — rendered by an adapter of its own (the SSR entry's process).
    const server = await freshApp();
    const { html } = await server.createSsrRenderer(server.resolve, { routes })(document_, { complete: true });
    const markup = await new Response(html).text();
    expect(markup).toContain('data-marmeon-layer="app/Edit"');

    // The browser: fresh modules — nothing of the layers loaded until createMarmeonApp loads them.
    vi.resetModules();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    history.replaceState(null, '', '/users/1/edit');
    document.head.innerHTML = `<script type="application/json" id="${PAGE_SCRIPT_ID}">${JSON.stringify(document_)}</script>`;
    document.body.innerHTML = `<div id="app">${markup}</div>`;
    const browser = await freshApp();
    const dialog = $('dialog');
    await act(async () => {
      await browser.createMarmeonApp({ resolve: browser.resolve, routes });
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(errors.mock.calls.filter(([message]) => !String(message).includes('multiple renderers'))).toEqual([]);
    expect($('[data-marmeon-hydration]')).toBeNull();
    // Hydrated, not rendered again: the server's dialog element is the one on screen — and it is the layer's.
    expect($('dialog')).toBe(dialog);
    expect(loadedLate()).toEqual([]);
    await click('[data-testid="close"]');
    await wait();
    expect(dialogs()).toEqual([]);
    expect(location.pathname).toBe('/users/1');
  });
});

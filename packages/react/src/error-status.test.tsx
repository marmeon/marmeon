// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/" }
import { loadHistoryFallback, type Navigator } from '@marmeon/http/client/adapter';
import { PAGE_HEADER, PAGE_SCRIPT_ID, PROTOCOL_VERSION, type PageObject } from '@marmeon/http/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp, useRouterContext } from './app.tsx';
import { createMarmeonApp } from './client.tsx';
import { ServerFailure } from './failure.tsx';
import { resolveModulePages } from './pages.ts';
import { createSsrRenderer } from './server.tsx';

const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NotFound = () => <p data-view="404">Nothing here</p>;
const Generic = () => <p data-view="Error">Something is wrong</p>;

const views = (names: Record<string, () => React.JSX.Element>) =>
  resolveModulePages(Object.fromEntries(Object.entries(names).map(([name, view]) => [`/modules/errors/views/${name}.tsx`, async () => ({ default: view })])));

const both = views({ '404': NotFound, Error: Generic });
const generic = views({ Error: Generic });
const neither = views({});

/** An error page as the server sends it: always `errors/Error` on the wire. */
const errorPage = (status: unknown): PageObject => ({ component: 'errors/Error', props: { status, title: 'Title', message: 'Message', exception: null }, url: '/missing', version: null });

async function ssr(resolve: ReturnType<typeof views>, page: PageObject): Promise<string> {
  return new Response((await createSsrRenderer(resolve)(page, { complete: true })).html).text();
}

afterEach(() => vi.restoreAllMocks());

describe('errors/<status>', () => {
  it('renders the view of the exact status on the server when the app has one, else errors/Error, else the built-in page', async () => {
    expect(await ssr(both, errorPage(404))).toContain('data-view="404"');
    expect(await ssr(both, errorPage(500))).toContain('data-view="Error"');
    expect(await ssr(both, errorPage('404'))).toContain('data-view="Error"'); // no pattern, no coercion
    expect(await ssr(generic, errorPage(404))).toContain('data-view="Error"');
    expect(await ssr(neither, errorPage(404))).not.toContain('data-view');
    expect(await ssr(neither, errorPage(404))).toContain('Message');
  });

  it('hydrates the same view in the browser', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent = errorPage(404);
    document.head.innerHTML = `<script type="application/json" id="${PAGE_SCRIPT_ID}">${JSON.stringify(sent)}</script>`;
    document.body.innerHTML = `<div id="app">${await ssr(both, sent)}</div>`;
    await act(async () => {
      await createMarmeonApp({ resolve: both });
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(document.querySelector('[data-view="404"]')!.textContent).toBe('Nothing here');
    expect(errors.mock.calls.filter(([message]) => !String(message).includes('multiple renderers'))).toEqual([]);
  });

  it('renders it for a visit the server answers with a 404 page object', async () => {
    let navigator: Navigator | null = null;
    function Start() {
      navigator = useRouterContext().navigator();
      return <p data-view="start">Start</p>;
    }
    const resolve = resolveModulePages({ '/modules/app/views/Start.tsx': async () => ({ default: Start }), '/modules/errors/views/404.tsx': async () => ({ default: NotFound }), '/modules/errors/views/Error.tsx': async () => ({ default: Generic }) });
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response(JSON.stringify(errorPage(404)), { status: 404, headers: { [PAGE_HEADER]: PROTOCOL_VERSION } }));
    history.replaceState(null, '', '/');
    const container = document.createElement('div');
    document.body.replaceChildren(container);
    const start: PageObject = { component: 'app/Start', props: {}, url: '/', version: null };
    const root = createRoot(container);
    await act(async () => {
      root.render(<MarmeonApp features={HISTORY} initialPage={start} initialComponent={await resolve('app/Start')} resolve={resolve} />);
    });
    await act(async () => {
      void navigator!.visit('/missing');
      await new Promise((done) => setTimeout(done, 30));
    });
    expect(container.querySelector('[data-view="404"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it('shows the view of the status in the dialog over a page after a 5xx', async () => {
    const Broken = () => <p data-view="500">Our fault</p>;
    const resolve = views({ '500': Broken, Error: Generic });
    const container = document.createElement('div');
    document.body.replaceChildren(container);
    const root = createRoot(container);
    const failure = { type: 'server' as const, status: 500, page: errorPage(500), html: null } as unknown as Parameters<typeof ServerFailure>[0]['failure'];
    await act(async () => {
      root.render(<ServerFailure failure={failure} resolve={resolve} onDismiss={() => {}} />);
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(container.querySelector('dialog [data-view="500"]')).not.toBeNull();
    await act(async () => root.unmount());
  });
});

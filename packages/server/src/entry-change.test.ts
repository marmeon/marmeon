import { ConsoleLogger, createApplication, defineModule, Logger, type Container } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpError, HttpServiceProvider, island, isPageObject, view, type PageObject, type SsrRender } from '@marmeon/http';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { describe, expect, it } from 'vitest';
import { packageTemplate } from './documents.ts';
import { FALLBACK_TEMPLATE } from './html.ts';
import { createHttpKernel, type KernelOptions } from './kernel.ts';
import { createDocumentRenderer, type DocumentRendererOptions } from './render.ts';
import { islandRoute } from './test-helpers/island-route.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const document = packageTemplate({ script: '/assets/pkg-status-a.js', preloads: [], stylesheets: [] });

/** What each controller computed: a page that is not shown must compute nothing. */
const computed: string[] = [];

const warned: string[] = [];
class CollectingLogger extends ConsoleLogger {
  override warn(message: string): void {
    warned.push(message);
  }
  override child(): Logger {
    return this;
  }
}
class LoggingProvider {
  register(container: Container) {
    container.singleton(Logger, () => new CollectingLogger());
  }
}

/** An app whose `/status` pages belong to the package entry "status". */
async function appWith(options: KernelOptions = {}, renderer: Partial<DocumentRendererOptions> = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, LoggingProvider],
    modules: [
      defineModule({
        name: 'pages',
        routes: openRoutes((Route) => {
          Route.get('/', () => view('demo/Home', { greeting: () => (computed.push('home'), 'hi') })).name('home');
          Route.get('/status', () => view('status::Index', { secret: () => (computed.push('status'), 'secret-value') })).name('status.index');
          Route.post('/status', () => view('status::Index', { secret: () => (computed.push('status-post'), 'secret-value') }));
          Route.post('/status/forbidden', () => {
            throw new HttpError(403, 'No.');
          });
          Route.get('/status/missing', () => {
            throw new HttpError(404);
          });
          Route.post('/status/write', () => (computed.push('write'), view('demo/Home', {})));
          Route.get('/islands/layer-panel', islandRoute(() => island('status::Panel', {})));
          Route.get('/status/layer-island', () => view('status::Edit', {}).layer({ base: 'home' })).name('status.layer-island');
          Route.post('/save', () => view('demo/Saved', {}));
          Route.get('/islands/status-panel', islandRoute(() => island('status::Panel', { rows: () => (computed.push('status-island'), [1]) })));
          Route.get('/islands/home-panel', islandRoute(() => island('demo/Panel', { rows: () => (computed.push('home-island'), [1]) })));
          // A layer of the status entry over a page of the app, and the other way round.
          Route.get('/status/edit', () => view('status::Edit', {}).layer({ base: 'home' })).name('status.edit');
          Route.get('/edit-home', () => view('demo/Edit', {}).layer({ base: 'status.index' })).name('home.edit');
          Route.get('/status/panel', () => view('status::Edit', {}).layer({ base: 'status.index' })).name('status.panel');
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey() } });
  const documentRenderer = createDocumentRenderer({
    template: () => FALLBACK_TEMPLATE,
    ssr: () => async () => ({ html: '<p>app</p>' }),
    version: 'app-v',
    packages: new Map([['status', { template: () => document, ssr: () => async () => ({ html: '<p>status</p>' }), version: 'status-v' }]]),
    ...renderer,
  });
  return createHttpKernel(application, { renderer: documentRenderer, ...options });
}

const html = { accept: 'text/html' };
/** A client-side request of the page protocol, from the document of `entry` (none: the app's). */
const client = (entry?: string, extra: Record<string, string> = {}) => ({ [PAGE_HEADER]: PROTOCOL_VERSION, ...(entry ? { 'x-marmeon-entry': entry } : {}), ...extra });

/** The page object a document carries (`#marmeon-page`). */
function documentPage(markup: string): PageObject {
  const match = /<script type="application\/json" id="marmeon-page">([\s\S]*?)<\/script>/.exec(markup);
  const page: unknown = match ? JSON.parse(match[1]!.replaceAll('\\u003c', '<')) : undefined;
  if (!isPageObject(page)) throw new Error(`No page in:\n${markup.slice(0, 400)}`);
  return page;
}

describe('a visit across package entries', () => {
  for (const [name, options] of [['with an asset version', {}], ['without one', { assetVersion: null }]] as const) {
    it(`loads the page fully when the client runs in another document, ${name}`, async () => {
      const app = await appWith(options);
      computed.length = 0;
      const toStatus = await app.request('/status?tab=1', { headers: client() });
      expect([toStatus.status, toStatus.headers.get('x-marmeon-reload'), toStatus.headers.get('x-marmeon-location'), toStatus.headers.get('cache-control')]).toEqual([409, 'entry', '/status?tab=1', 'no-store']);
      expect(toStatus.headers.get('vary')).toContain('x-marmeon-entry');
      expect(await toStatus.text()).toBe('');
      const toHome = await app.request('/', { headers: client('status') });
      expect([toHome.status, toHome.headers.get('x-marmeon-reload'), toHome.headers.get('x-marmeon-location')]).toEqual([409, 'entry', '/']);
      // The 409 carries no prop of the page, and none was computed.
      expect(computed).toEqual([]);
    });
  }

  it("stays on the page of the client's own document", async () => {
    const app = await appWith({ assetVersion: null });
    const own = (await (await app.request('/status', { headers: client('status') })).json()) as PageObject;
    expect([own.component, own.entry]).toEqual(['status::Index', 'status']);
    const home = (await (await app.request('/', { headers: client() })).json()) as PageObject;
    expect(home.component).toBe('demo/Home');
    expect(home).not.toHaveProperty('entry');
  });

  it('loads fully for every method: a write to a page of another document is not answered with its page', async () => {
    const app = await appWith();
    computed.length = 0;
    const post = await app.request('/status', { method: 'POST', headers: client() });
    expect([post.status, post.headers.get('x-marmeon-reload')]).toEqual([409, 'entry']);
    expect(computed).toEqual([]);
    // The write of the client's own document is answered as before.
    expect((await app.request('/save', { method: 'POST', headers: client() })).status).toBe(200);
  });

  it('refuses the island of another document with 404, before any of its props is computed', async () => {
    const app = await appWith();
    computed.length = 0;
    const foreign = await app.request('/islands/status-panel', { headers: client(undefined, { 'x-marmeon-region': 'island' }) });
    expect(foreign.status).toBe(404);
    expect(computed).toEqual([]);
    const own = await app.request('/islands/status-panel', { headers: client('status', { 'x-marmeon-region': 'island' }) });
    expect(own.status).toBe(200);
    expect(computed).toEqual(['status-island']);
    const other = await app.request('/islands/home-panel', { headers: client('status', { 'x-marmeon-region': 'island' }) });
    expect(other.status).toBe(404);
  });

  it("resolves a page's island in-process as a client of the page's own document", async () => {
    const outcomes: string[] = [];
    const resolving = (label: string) => (): SsrRender => async (_page, options) => {
      outcomes.push(`${label}:${(await options?.resolveIsland?.('/islands/status-panel'))?.status}`);
      return { html: `<p>${label}</p>` };
    };
    const app = await appWith({}, {
      ssr: resolving('app'),
      packages: new Map([['status', { template: () => document, ssr: resolving('status'), version: 'status-v' }]]),
    });
    await (await app.request('/status', { headers: html })).text();
    await (await app.request('/', { headers: html })).text();
    // The package's own page gets its island; the app's page asking for the package's island is turned away.
    expect(outcomes).toEqual(['status:ready', 'app:exception']);
  });

  it('shows a layer alone over the backdrop when its base is of another document, in the layer\'s document', async () => {
    const app = await appWith({ assetVersion: null });
    computed.length = 0;
    const packageLayer = await (await app.request('/status/edit', { headers: html })).text();
    const page = documentPage(packageLayer);
    expect([page.component, page.entry, page.layers?.map((layer) => layer.component)]).toEqual(['system/layers/Backdrop', 'status', ['status::Edit']]);
    expect(packageLayer).toContain('pkg-status-a.js');
    expect(packageLayer).not.toContain('greeting');
    const appLayer = documentPage(await (await app.request('/edit-home', { headers: html })).text());
    expect([appLayer.component, appLayer.layers?.map((layer) => layer.component)]).toEqual(['system/layers/Backdrop', ['demo/Edit']]);
    expect(appLayer).not.toHaveProperty('entry');
    expect(computed).not.toContain('status');
  });

  it('shows a layer over a base of its own document', async () => {
    const app = await appWith({ assetVersion: null });
    const page = documentPage(await (await app.request('/status/panel', { headers: html })).text());
    expect([page.component, page.entry, page.layers?.map((layer) => layer.component)]).toEqual(['status::Index', 'status', ['status::Edit']]);
  });

  it('carries the document in a page of the package, and leaves the app\'s own page as it was', async () => {
    const app = await appWith();
    const status = documentPage(await (await app.request('/status', { headers: html })).text());
    expect(status.entry).toBe('status');
    const home = documentPage(await (await app.request('/', { headers: html })).text());
    expect(home).not.toHaveProperty('entry');
  });
});

describe('an app without package entries', () => {
  it('has no new header, no new 409 and no entry on its pages, whatever a client sends', async () => {
    const app = await appWith({ assetVersion: null }, { packages: undefined });
    const plain = await app.request('/', { headers: client() });
    expect(plain.status).toBe(200);
    expect(plain.headers.get('vary')).not.toContain('x-marmeon-entry');
    expect(await plain.json()).not.toHaveProperty('entry');
    const claimed = await app.request('/', { headers: client('status') });
    expect(claimed.status).toBe(200);
    expect((await app.request('/status', { headers: client() })).status).toBe(200);
  });
});

describe('what stays neutral across package entries', () => {
  it('answers an error in the package document with its error page, never a reload', async () => {
    const app = await appWith();
    computed.length = 0;
    const forbidden = await app.request('/status/forbidden', { method: 'POST', headers: client('status') });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('x-marmeon-reload')).toBeNull();
    expect(((await forbidden.json()) as PageObject).component).toBe('system/errors/Error');
    const missing = await app.request('/status/missing', { headers: client('status') });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-marmeon-reload')).toBeNull();
    // The app's own client gets its error page as before.
    expect((await app.request('/status/missing', { headers: client() })).status).toBe(404);
  });

  it("resolves a package layer's island over the backdrop as an island of the layer's document", async () => {
    const outcomes: string[] = [];
    const resolving = () => async (_page: PageObject, options?: { resolveIsland?: (url: string) => Promise<{ status: string }> }) => {
      outcomes.push((await options?.resolveIsland?.('/islands/layer-panel'))?.status ?? 'none');
      return { html: '' };
    };
    const app = await appWith({ assetVersion: null }, {
      packages: new Map([['status', { template: () => document, ssr: resolving, version: 'status-v' }]]),
    });
    await (await app.request('/status/layer-island', { headers: html })).text();
    expect(outcomes).toEqual(['ready']);
  });

  it('says in debug mode that a write crossed entries after its controller ran, and stays quiet for a GET', async () => {
    const app = await appWith({ debug: true });
    computed.length = 0;
    warned.length = 0;
    const post = await app.request('/status/write', { method: 'POST', headers: client('status') });
    expect([post.status, post.headers.get('x-marmeon-reload'), post.headers.get('x-marmeon-location')]).toEqual([409, 'entry', '/status/write']);
    // The controller has run: the response is only what the browser does next (GET of the same URL).
    expect(computed).toEqual(['write']);
    expect(warned.join('\n')).toContain('the controller has run');
    warned.length = 0;
    await app.request('/', { headers: client('status') });
    expect(warned).toEqual([]);
    const quiet = await appWith();
    await quiet.request('/status/write', { method: 'POST', headers: client('status') });
    expect(warned).toEqual([]);
  });
});

import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, view, type PageObject } from '@marmeon/http';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { describe, expect, it } from 'vitest';
import { packageTemplate } from './documents.ts';
import { FALLBACK_TEMPLATE } from './html.ts';
import { createHttpKernel, type KernelOptions } from './kernel.ts';
import { createDocumentRenderer, type DocumentRendererOptions } from './render.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const document = packageTemplate({ script: '/assets/pkg-status-a.js', preloads: [], stylesheets: [] });

/** An app whose `/status` page belongs to the package entry "status", `/help` to an installed package without an entry. */
async function appWith(options: KernelOptions = {}, renderer: Partial<DocumentRendererOptions> = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [
      defineModule({
        name: 'pages',
        routes: openRoutes((Route) => {
          Route.get('/', () => view('demo/Home', {}));
          Route.get('/status', () => view('status::Index', {}));
          Route.get('/help', () => view('help::Article', {}));
          Route.get('/nope', () => view('nope::X', {}));
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey() } });
  const documentRenderer = createDocumentRenderer({
    template: () => FALLBACK_TEMPLATE,
    ssr: () => async () => ({ html: '<p>app</p>' }),
    version: 'app-v',
    packages: new Map([['status', { template: () => document, ssr: () => async () => ({ html: '<p>status</p>' }), version: 'status-v' }]]),
    installed: new Set(['status', 'help']),
    ...renderer,
  });
  return createHttpKernel(application, { renderer: documentRenderer, ...options });
}

const html = { accept: 'text/html' };
const visit = (version?: string) => ({ [PAGE_HEADER]: PROTOCOL_VERSION, ...(version ? { 'x-marmeon-version': version } : {}) });

describe('a package entry in the kernel', () => {
  it("renders each view in its own document: the package's page in the package's, the app's in the app's", async () => {
    const app = await appWith();
    const status = await (await app.request('/status', { headers: html })).text();
    expect(status).toContain('<p>status</p>');
    expect(status).toContain('src="/assets/pkg-status-a.js"');
    const home = await (await app.request('/', { headers: html })).text();
    expect(home).toContain('<p>app</p>');
    expect(home).not.toContain('pkg-status-a.js');
    // A package that is installed without an entry shows its page in the app's document.
    expect(await (await app.request('/help', { headers: html })).text()).toContain('<p>app</p>');
  });

  it("carries the version of the document the page renders in", async () => {
    const app = await appWith();
    expect(((await (await app.request('/status', { headers: visit('status-v') })).json()) as PageObject).version).toBe('status-v');
    expect(((await (await app.request('/', { headers: visit('app-v') })).json()) as PageObject).version).toBe('app-v');
  });

  it("answers an unknown namespace with 500 and H16 — never with the app's document", async () => {
    const app = await appWith({ debug: true });
    const response = await app.request('/nope', { headers: html });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('H16');
    expect(body).not.toContain('<p>app</p>');
    expect((await app.request('/nope', { headers: visit('app-v') })).status).toBe(500);
  });

  it('counts every entry\'s version as current: only a version no entry has is stale', async () => {
    const app = await appWith();
    for (const version of ['app-v', 'status-v']) {
      expect((await app.request('/', { headers: visit(version) })).status).toBe(200);
      expect((await app.request('/status', { headers: visit(version) })).status).toBe(200);
    }
    const stale = await app.request('/status', { headers: visit('old-v') });
    expect([stale.status, stale.headers.get('x-marmeon-reload')]).toEqual([409, 'version']);
  });

  it('derives the versions from an assetVersion the app sets: the value for the app, `<value>+<namespace>` for a package', async () => {
    const app = await appWith({ assetVersion: 'v9' });
    expect(((await (await app.request('/', { headers: visit('v9') })).json()) as PageObject).version).toBe('v9');
    expect(((await (await app.request('/status', { headers: visit('v9+status') })).json()) as PageObject).version).toBe('v9+status');
    expect((await app.request('/status', { headers: visit('status-v') })).status).toBe(409);
  });
});

describe('an app without package entries', () => {
  it('keeps one version and one document: every view is the app\'s, whatever its name', async () => {
    const app = await appWith({}, { packages: undefined, installed: undefined });
    const nope = await app.request('/nope', { headers: html });
    expect(nope.status).toBe(200);
    expect(await nope.text()).toContain('<p>app</p>');
    expect(((await (await app.request('/status', { headers: visit('app-v') })).json()) as PageObject).version).toBe('app-v');
    expect((await app.request('/', { headers: visit('status-v') })).status).toBe(409);
  });
});

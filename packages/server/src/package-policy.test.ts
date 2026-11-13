import { createApplication, defineModule, Logger, type Container, type LogContext } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { cacheControl, contentSecurityPolicy, HttpServiceProvider, SharedData, view } from '@marmeon/http';
import { defineMiddleware, type HttpContext, type Next } from '@marmeon/router';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { describe, expect, it } from 'vitest';
import { packageTemplate } from './documents.ts';
import { FALLBACK_TEMPLATE } from './html.ts';
import { createHttpKernel, type KernelOptions } from './kernel.ts';
import { createDocumentRenderer, type DocumentRendererOptions } from './render.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const statusDocument = packageTemplate({ script: '/assets/pkg-status-a.js', preloads: ['/assets/shared-a.js'], stylesheets: ['/assets/pkg-status-a.css'] });
const html = { accept: 'text/html' };
const STRICT = /^script-src 'nonce-([A-Za-z0-9+/=]+)' 'strict-dynamic'; object-src 'none'; base-uri 'self'$/;

interface Setup {
  kernel?: KernelOptions;
  renderer?: Partial<DocumentRendererOptions>;
  global?: unknown[];
  group?: unknown;
  warnings?: string[];
}

/** Fails after the package document was made, and then makes every shared prop fail, so the error page cannot be built in the request's scope. */
class FailsAfterwards {
  readonly #shared: SharedData;
  constructor(shared: SharedData) {
    this.#shared = shared;
  }
  async handle(_ctx: HttpContext, next: Next<{}>): Promise<Response> {
    const share = this.#shared as unknown as { share(key: string, value: unknown): void };
    share.share('broken', () => 1);
    await next();
    // Shared props resolve once per request: sharing again is what makes the error page's evaluation fail.
    share.share('broken', () => {
      throw new Error('shared prop failed');
    });
    throw new Error('late');
  }
}

const quiet = (warnings: string[]): Logger => {
  const logger: Logger = { debug() {}, info() {}, warn: (message: string, _context?: LogContext) => void warnings.push(message), error() {}, child: () => logger };
  return logger;
};

/** `/status` renders in the package's document, `/` in the app's, `/broken` fails in a package's page, `/boom` throws before any page. */
async function appWith({ kernel = {}, renderer = {}, global = [], group, warnings }: Setup = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    middleware: { global: global as never },
    modules: [
      defineModule({
        name: 'pages',
        routes: openRoutes((Route) => {
          Route.get('/', () => view('demo/Home', {}));
          Route.get('/boom', () => {
            throw new Error('boom');
          });
          Route.get('/status', () => view('status::Index', {}));
          Route.middleware(defineMiddleware('Late', async (_ctx, next) => {
            await next();
            throw new Error('late');
          })).get('/status/late', () => view('status::Index', {}));
          Route.middleware(FailsAfterwards).get('/status/broken', () => view('status::Index', {}));
          Route.middleware(cacheControl('public, max-age=60')).get('/status/public', () => view('status::Index', {}));
          Route.middleware(cacheControl('s-maxage=60')).get('/status/shared', () => view('status::Index', {}));
          (group ? Route.middleware(group as never) : Route).get('/status/area', () => view('status::Area', {}));
        }),
      }),
    ],
  }, {
    env: { APP_KEY: generateKey() },
    ...(warnings ? { override: (container: Container) => container.instance(Logger, quiet(warnings)) } : {}),
  });
  const documentRenderer = createDocumentRenderer({
    template: () => FALLBACK_TEMPLATE,
    ssr: () => async (page) => {
      if (page.component === 'status::Area' && page.props.fail === true) throw new Error('render failed');
      return { html: `<p>${page.component}</p>` };
    },
    version: 'app-v',
    packages: new Map([['status', { template: () => statusDocument, ssr: () => async (page) => ({ html: `<p>${page.component}</p>` }), version: 'status-v' }]]),
    ...renderer,
  });
  return createHttpKernel(application, { renderer: documentRenderer, ...kernel });
}

const nonceOf = (document: string) => /<script[^>]* nonce="([^"]+)"/.exec(document)![1]!;

describe("the document of a package's entry", () => {
  it("gets the strict default policy with the response's nonce when no route or app sets one", async () => {
    const app = await appWith();
    const response = await app.request('/status', { headers: html });
    const body = await response.text();
    const policy = response.headers.get('content-security-policy')!;
    expect(policy).toMatch(STRICT);
    // The nonce of the header is the one on every tag of the document.
    const nonce = STRICT.exec(policy)![1]!;
    expect(nonceOf(body)).toBe(nonce);
    expect(body.match(new RegExp(`nonce="${nonce.replace(/[+/=]/g, '\\$&')}"`, 'g'))!.length).toBeGreaterThanOrEqual(3);
    expect(body).not.toContain('marmeon:csp-nonce');
    // A new response, a new nonce.
    expect(STRICT.exec((await app.request('/status', { headers: html })).headers.get('content-security-policy')!)![1]).not.toBe(nonce);
  });

  it('gets it without server rendering, on the first load (the document without markup)', async () => {
    const app = await appWith({ kernel: { ssr: false } });
    const response = await app.request('/status', { headers: html });
    const nonce = STRICT.exec(response.headers.get('content-security-policy')!)![1]!;
    expect(nonceOf(await response.text())).toBe(nonce);
  });

  it('gets it when server rendering failed and the browser renders the page', async () => {
    const app = await appWith({ renderer: { packages: new Map([['status', { template: () => statusDocument, ssr: () => async () => { throw new Error('render failed'); } }]]) } });
    const response = await app.request('/status', { headers: html });
    expect(response.status).toBe(200);
    const nonce = STRICT.exec(response.headers.get('content-security-policy')!)![1]!;
    expect(nonceOf(await response.text())).toBe(nonce);
  });

  it('gets it in development, where the renderer reports the failure inside the package document', async () => {
    const app = await appWith({
      kernel: { debug: true },
      renderer: {
        packages: new Map([['status', { template: () => statusDocument, ssr: () => async () => { throw new Error('render failed'); } }]]),
        failed: async () => '<div id="overlay"></div>',
      },
    });
    const response = await app.request('/status', { headers: html });
    const body = await response.text();
    expect(body).toContain('id="overlay"');
    expect(nonceOf(body)).toBe(STRICT.exec(response.headers.get('content-security-policy')!)![1]);
  });

  it("keeps the policy of its route group, and the app's global policy when no group sets one", async () => {
    const group = contentSecurityPolicy({ scriptSrc: ["'self'"], styleSrc: ["'self'"] });
    const grouped = await appWith({ group, global: [contentSecurityPolicy({ scriptSrc: ["'none'"] })] });
    const response = await grouped.request('/status/area', { headers: html });
    expect(response.headers.get('content-security-policy')).toBe("script-src 'self'; object-src 'none'; base-uri 'self'; style-src 'self'");
    const global = await grouped.request('/status', { headers: html });
    expect(global.headers.get('content-security-policy')).toBe("script-src 'none'; object-src 'none'; base-uri 'self'");
  });

  it("enforces the default next to an app's report-only policy, which stays", async () => {
    const app = await appWith({ global: [contentSecurityPolicy({ reportOnly: true })] });
    const response = await app.request('/status', { headers: html });
    const nonce = STRICT.exec(response.headers.get('content-security-policy')!)![1]!;
    expect(nonceOf(await response.text())).toBe(nonce);
    expect(response.headers.get('content-security-policy-report-only')).toMatch(STRICT);
  });

  it('keeps the strict default and warns once when the document is cacheable by a shared cache', async () => {
    const warnings: string[] = [];
    const app = await appWith({ warnings });
    for (const path of ['/status/public', '/status/public', '/status/shared']) {
      const response = await app.request(path, { headers: html });
      expect(response.headers.get('content-security-policy')).toMatch(STRICT);
    }
    expect(warnings.filter((message) => message.includes('cached publicly'))[0]).toContain('give its route group a contentSecurityPolicy() without NONCE');
    expect(warnings.filter((message) => message.includes('cached publicly'))[0]).not.toContain('leave it out of');
    expect(warnings.filter((message) => message.includes('cached publicly'))).toEqual([
      expect.stringContaining('/status/public is cached publicly (Cache-Control: public, max-age=60) and carries a CSP nonce'),
      expect.stringContaining('/status/shared is cached publicly (Cache-Control: s-maxage=60) and carries a CSP nonce'),
    ]);
  });

  it('does not warn for a private document', async () => {
    const warnings: string[] = [];
    const app = await appWith({ warnings });
    await app.request('/status', { headers: html });
    expect(warnings.filter((message) => message.includes('cached publicly'))).toEqual([]);
  });

  it("does not give the app's error document the default when a middleware fails after the package document was made", async () => {
    const app = await appWith();
    const response = await app.request('/status/late', { headers: html });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('pkg-status-a.js');
    expect(response.headers.has('content-security-policy')).toBe(false);
  });

  it("does not give the app's fallback error page the default when the error page cannot be built in the request's scope", async () => {
    const app = await appWith();
    const response = await app.request('/status/broken', { headers: html });
        expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('pkg-status-a.js');
    expect(response.headers.has('content-security-policy')).toBe(false);
  });

  it('is not sent to a visit, which gets the page as JSON and no document', async () => {
    const app = await appWith();
    const response = await app.request('/status', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, 'x-marmeon-entry': 'status', 'x-marmeon-version': 'status-v' } });
    expect(response.headers.get('content-type')).toContain('json');
    expect(response.headers.has('content-security-policy')).toBe(false);
  });

  it('refuses to show a package document in a request with no nonce to carry', async () => {
    const { createResponseFactory } = await import('./render.ts');
    const factory = createResponseFactory(createDocumentRenderer({
      template: () => FALLBACK_TEMPLATE,
      ssr: () => async () => ({ html: '' }),
      packages: new Map([['status', { template: () => statusDocument, ssr: () => async () => ({ html: '' }) }]]),
    }));
    await expect(factory(view('status::Index', {}), { request: new Request('http://localhost/status', { headers: html }) })).rejects.toThrow(/needs the response's nonce/);
  });
});

describe('the app\'s own documents', () => {
  it('carry no header and no nonce when the app sets no policy, with package entries or without', async () => {
    for (const renderer of [{}, { packages: undefined }]) {
      const app = await appWith({ renderer });
      const response = await app.request('/', { headers: html });
      expect(response.headers.has('content-security-policy')).toBe(false);
      expect(response.headers.has('content-security-policy-report-only')).toBe(false);
      expect(await response.text()).not.toContain('nonce=');
    }
  });

  it("stay free of it on the error page, whose first load shows the app's document", async () => {
    const app = await appWith();
    const response = await app.request('/boom', { headers: html });
    expect(response.status).toBe(500);
    expect(response.headers.has('content-security-policy')).toBe(false);
  });

  it('are the same whether package entries exist or not, apart from vary', async () => {
    const without = await appWith({ renderer: { packages: undefined } });
    const withEntries = await appWith();
    const a = await without.request('/', { headers: html });
    const b = await withEntries.request('/', { headers: html });
    // The epoch is per application instance.
    const plain = async (response: Response) => (await response.text()).replace(/"epoch":"[^"]*"/, '"epoch":"-"');
    expect(await plain(b)).toBe(await plain(a));
    // `vary` names the entry header where package entries exist.
    const headers = (response: Response) => [...response.headers].filter(([name]) => !['date', 'vary', 'x-request-id'].includes(name));
    expect(headers(b)).toEqual(headers(a));
  });
});

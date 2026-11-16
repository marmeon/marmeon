import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, view, type HttpContext, type SsrRender } from '@marmeon/http';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { PageAlternates, UrlLocales } from '@marmeon/router/internal';
import { describe, expect, it } from 'vitest';
import { FALLBACK_TEMPLATE } from './html.ts';
import { createHttpKernel } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';
import { createDocumentRenderer } from './render.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

/** A UI-free SSR entry that states the address it was given for the head, as `<Head canonical>` would. */
const render: SsrRender = async (page, options = {}) => ({
  html: '<main>shell</main>',
  head:
    options.appUrl === undefined
      ? '<meta name="app-url" content="none"/>'
      : `<link rel="canonical" href="${new URL(page.url, options.appUrl).href}"/>` +
        Object.entries(page.alternates ?? {}).map(([locale, path]) => `<link rel="alternate" hreflang="${locale}" href="${new URL(path, options.appUrl).href}"/>`).join(''),
});

/** What `SetLocale` of `@marmeon/i18n` does for a localized page: the alternates of the request's scope. */
class AlternatesController extends Controller {
  readonly #alternates: PageAlternates;
  constructor(alternates: PageAlternates) {
    super();
    this.#alternates = alternates;
  }
  handle() {
    this.#alternates.set({ en: '/en/about', de: '/de/about', 'x-default': '/about' });
    return view('about/Show', {});
  }
}

async function appWith(env: Record<string, string>) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    modules: [defineModule({ name: 'head-fields', routes: openRoutes((Route) => {
      Route.get('/profile', (_ctx: HttpContext) => view('users/Show', {}));
      Route.localized().get('/about', AlternatesController);
    }) })],
  }, { env: { APP_KEY: generateKey(), SERVER_TRUSTED_PROXIES: '127.0.0.1', ...env } });
  application.container.instance(UrlLocales, { supported: ['en', 'de'], preferred: async () => 'de' });
  application.container.scoped(PageAlternates);
  return createHttpKernel(application, { renderer: createDocumentRenderer({ template: () => FALLBACK_TEMPLATE, ssr: () => render }) });
}

/** The page's own text with its per-session epoch fixed, so a document compares whole. */
const withoutEpoch = (html: string) => html.replace(/"epoch":"[^"]+"/, '"epoch":"E"');
const PROFILE = '{"component":"users/Show","props":{},"url":"/profile","version":null,"epoch":"E"}';
/** The test renderer's document around `head` and the page object `page`. */
const documentOf = (head: string, page: string) =>
  `<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><title>Marmeon</title>${head}<script type="application/json" id="marmeon-page">${page}</script>\n</head>\n  <body><div id="app"><main>shell</main></div></body>\n</html>`;

describe('the document head names the app, not the request', () => {
  it('builds absolute URLs from APP_URL', async () => {
    const app = await appWith({ APP_URL: 'https://app.example' });
    const html = await (await app.request('/profile', { headers: { accept: 'text/html' } })).text();
    expect(html).toContain('<link rel="canonical" href="https://app.example/profile"/>');
  });

  it('gives the browser the origin once, in the first document — not in a visit\'s answer', async () => {
    const app = await appWith({ APP_URL: 'https://app.example/base?x=1' });
    expect(await (await app.request('/profile', { headers: { accept: 'text/html' } })).text()).toContain('<meta name="marmeon-app-origin" content="https://app.example">');
    const visit = await (await app.request('/profile', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } })).text();
    expect(JSON.parse(visit)).toEqual({ component: 'users/Show', props: {}, url: '/profile', version: null, epoch: expect.any(String) });
    const unset = await (await appWith({})).request('/profile', { headers: { accept: 'text/html' } });
    expect(await unset.clone().text()).toContain('<title>Marmeon</title><meta name="app-url" content="none"/>');
    expect(withoutEpoch(await unset.text())).toBe(documentOf('<meta name="app-url" content="none"/>', PROFILE));
  });

  it('escapes the origin it writes', async () => {
    const app = await appWith({ APP_URL: 'https://a"b.example' });
    const html = await (await app.request('/profile', { headers: { accept: 'text/html' } })).text();
    expect(html).toContain('<meta name="marmeon-app-origin" content="https://a&#34;b.example">');
    expect(html.match(/<meta name="marmeon-app-origin"[^>]*>/g)).toEqual(['<meta name="marmeon-app-origin" content="https://a&#34;b.example">']);
  });

  it('ignores Host and X-Forwarded-Host, even behind a trusted proxy', async () => {
    const app = await appWith({ APP_URL: 'https://app.example' });
    const response = await app.request(
      '/profile',
      { headers: { accept: 'text/html', host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } },
      { remoteAddress: '127.0.0.1' },
    );
    const html = await response.text();
    expect(html).toContain('<link rel="canonical" href="https://app.example/profile"/>');
    expect(withoutEpoch(html)).toBe(documentOf('<meta name="marmeon-app-origin" content="https://app.example">\n<link rel="canonical" href="https://app.example/profile"/>', PROFILE));
  });

  it('hands the renderer no address without APP_URL, whatever the request says', async () => {
    const app = await appWith({});
    const html = await (await app.request('/profile', { headers: { accept: 'text/html', host: 'evil.example', 'x-forwarded-host': 'evil.example' } }, { remoteAddress: '127.0.0.1' })).text();
    expect(html).toContain('<meta name="app-url" content="none"/>');
    expect(withoutEpoch(html)).toBe(documentOf('<meta name="app-url" content="none"/>', PROFILE));
  });

  it('names the languages of a localized page from APP_URL, behind a trusted proxy with a foreign Host', async () => {
    const app = await appWith({ APP_URL: 'https://app.example' });
    const response = await app.request(
      '/de/about',
      { headers: { accept: 'text/html', host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } },
      { remoteAddress: '127.0.0.1' },
    );
    const html = await response.text();
    expect(html).toContain('<link rel="canonical" href="https://app.example/de/about"/>');
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://app.example/en/about"/>');
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://app.example/about"/>');
    expect(withoutEpoch(html)).toBe(
      documentOf(
        '<meta name="marmeon-app-origin" content="https://app.example">\n<link rel="canonical" href="https://app.example/de/about"/><link rel="alternate" hreflang="en" href="https://app.example/en/about"/><link rel="alternate" hreflang="de" href="https://app.example/de/about"/><link rel="alternate" hreflang="x-default" href="https://app.example/about"/>',
        '{"component":"about/Show","props":{},"url":"/de/about","version":null,"alternates":{"en":"/en/about","de":"/de/about","x-default":"/about"},"epoch":"E"}',
      ),
    );
  });
});

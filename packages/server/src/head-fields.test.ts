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
    expect(visit).toContain('"component":"users/Show"');
    expect(visit).not.toContain('app.example');
    expect(await (await (await appWith({})).request('/profile', { headers: { accept: 'text/html' } })).text()).not.toContain('marmeon-app-origin');
  });

  it('escapes the origin it writes', async () => {
    const app = await appWith({ APP_URL: 'https://a"b.example' });
    const html = await (await app.request('/profile', { headers: { accept: 'text/html' } })).text();
    expect(html).toContain('<meta name="marmeon-app-origin" content="https://a&#34;b.example">');
    expect(html).not.toContain('content="https://a"b');
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
    expect(html).not.toContain('evil.example');
  });

  it('hands the renderer no address without APP_URL, whatever the request says', async () => {
    const app = await appWith({});
    const html = await (await app.request('/profile', { headers: { accept: 'text/html', host: 'evil.example', 'x-forwarded-host': 'evil.example' } }, { remoteAddress: '127.0.0.1' })).text();
    expect(html).toContain('<meta name="app-url" content="none"/>');
    expect(html).not.toContain('evil.example');
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
    expect(html).not.toContain('evil.example');
  });
});

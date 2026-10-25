import { createApplication, defineModule, Translator } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, view, type PageObject } from '@marmeon/http';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { defineRoutes, everyone } from '@marmeon/router';
import { PageAlternates, UrlLocales } from '@marmeon/router/internal';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';

/** What `SetLocale` of `@marmeon/i18n` does for a localized page: the alternates of the request's scope. */
class AlternatesController extends Controller {
  readonly #alternates: PageAlternates;
  constructor(alternates: PageAlternates) {
    super();
    this.#alternates = alternates;
  }
  handle() {
    this.#alternates.set({ en: '/en/about?x=1', de: '/de/about?x=1', 'x-default': '/about?x=1' });
    return view('about/Show', {});
  }
}

async function kernel() {
  const routes = defineRoutes((Root) => {
    const open = Root.authorize(everyone);
    open.localized().get('/about', AlternatesController).name('about');
    open.get('/plain', () => view('plain/Show', {}));
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [defineModule({ name: 'pages', routes })],
  }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' } });
  const { container } = application;
  container.instance(UrlLocales, { supported: ['en', 'de'], preferred: async () => 'de' });
  container.scoped(PageAlternates);
  container.scoped(Translator, () => ({ locale: 'de', has: () => false, text: (key: string) => key }));
  return createHttpKernel(application);
}

const visit = { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } };

describe('the page object of a localized route', () => {
  it('carries the alternates the request set — every locale and x-default, paths with their query', async () => {
    const app = await kernel();
    const page = (await (await app.request('/de/about', visit)).json()) as PageObject;
    expect(page.alternates).toEqual({ en: '/en/about?x=1', de: '/de/about?x=1', 'x-default': '/about?x=1' });
  });

  it('carries them in the document too, for hydration', async () => {
    const app = await kernel();
    const html = await (await app.request('/de/about')).text();
    expect(html).toContain('"alternates":{"en":"/en/about?x=1"');
  });

  it('has no alternates field on a page that sets none', async () => {
    const app = await kernel();
    const page = (await (await app.request('/plain', visit)).json()) as PageObject;
    expect('alternates' in page).toBe(false);
  });
});

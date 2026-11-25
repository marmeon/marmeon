import { createApplication, defineModule, Translator } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { abort, Controller, HttpServiceProvider, island, view, type PageObject } from '@marmeon/http';
import { PAGE_HEADER, PAGE_SCRIPT_ID, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { defineRoutes, everyone } from '@marmeon/router';
import { PageAlternates, UrlLocales } from '@marmeon/router/internal';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { islandRoute } from './test-helpers/island-route.ts';

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

async function kernel(unprefixed?: string) {
  const routes = defineRoutes((Root) => {
    const open = Root.authorize(everyone);
    open.localized().get('/about', AlternatesController).name('about');
    open.get('/plain', () => view('plain/Show', {}));
    open.get('/gate', () => abort(403, 'Closed.')).name('gate');
    open.get('/gate/note', () => view('gate/Note', {}).layer({ base: 'gate' }));
    open.get('/islands/panel', islandRoute(() => island('plain/Panel', {})));
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [defineModule({ name: 'pages', routes })],
  }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' } });
  const { container } = application;
  container.instance(UrlLocales, { supported: ['en', 'de'], unprefixed, preferred: async () => 'de' });
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

describe('the page object with the locale without a prefix', () => {
  it('carries urlLocales on every page, a localized one or not', async () => {
    const app = await kernel('de');
    for (const path of ['/about', '/plain']) {
      const page = (await (await app.request(path, visit)).json()) as PageObject;
      expect(page.urlLocales).toEqual({ unprefixed: 'de', supported: ['en', 'de'] });
    }
  });

  it('carries it in the document’s page script too, for hydration', async () => {
    const html = await (await (await kernel('de')).request('/about')).text();
    const script = new RegExp(`<script[^>]*id="${PAGE_SCRIPT_ID}"[^>]*>(.*?)</script>`, 's').exec(html)![1]!;
    expect((JSON.parse(script) as PageObject).urlLocales).toEqual({ unprefixed: 'de', supported: ['en', 'de'] });
  });

  it('has no urlLocales while every locale has a prefix', async () => {
    const app = await kernel();
    for (const path of ['/de/about', '/plain']) {
      const page = (await (await app.request(path, visit)).json()) as PageObject;
      expect('urlLocales' in page).toBe(false);
    }
  });

  it('is on the backdrop of a layer whose base does not answer, as on the page', async () => {
    const html = await (await (await kernel('de')).request('/gate/note')).text();
    const script = new RegExp(`<script[^>]*id="${PAGE_SCRIPT_ID}"[^>]*>(.*?)</script>`, 's').exec(html)![1]!;
    const backdrop = JSON.parse(script) as PageObject;
    expect(backdrop.component).toBe('system/layers/Backdrop');
    expect(backdrop.urlLocales).toEqual({ unprefixed: 'de', supported: ['en', 'de'] });
    expect(backdrop.layers).toHaveLength(1);
  });

  it('is not on an island’s answer — it builds its address in the page’s', async () => {
    const answer = await (await kernel('de')).request('/islands/panel', { headers: { ...visit.headers, 'x-marmeon-region': 'island' } });
    expect(answer.status).toBe(200);
    expect('urlLocales' in ((await answer.json()) as object)).toBe(false);
  });
});

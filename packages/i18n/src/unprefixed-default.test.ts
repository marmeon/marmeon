import { join } from 'node:path';
import { createApplication, defineModule, type Container, type ErrorReport, type ErrorReporter } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, PageAlternates, view, type HttpContext, type PageObject, type SitemapEntries } from '@marmeon/http';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { defineRoutes, everyone, Router, type RouteDefinitions } from '@marmeon/router';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import type { PageRenderer } from '@marmeon/server/internal';
import { Session, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { I18nServiceProvider, Locales, RequestLocale, Translator } from './index.ts';

const root = join(import.meta.dirname, '__fixtures__', 'shop');
const APP_URL = 'https://shop.example';

class AboutController extends Controller {
  readonly #translator: Translator;
  constructor(translator: Translator) {
    super();
    this.#translator = translator;
  }
  handle() {
    return view('shop/About', { greeting: this.#translator.get('shop.greeting', { name: 'Ada' }) });
  }
  sitemap(): SitemapEntries<{}> {
    return [{ params: {} }];
  }
}

class SessionLocaleController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle(ctx: HttpContext<{}, { locale: string }>) {
    this.#session.put('locale', ctx.params.locale);
    return { ok: true };
  }
}

/** A page whose path differs per language: it names its versions itself. */
class TranslatedController extends Controller {
  readonly #alternates: PageAlternates;
  constructor(alternates: PageAlternates) {
    super();
    this.#alternates = alternates;
  }
  handle() {
    this.#alternates.replace({ en: { slug: 'getting-started' }, de: { slug: 'erste-schritte' }, 'x-default': { locale: 'en', slug: 'getting-started' } });
    return view('shop/About', {});
  }
}

class UseLocaleController extends Controller {
  readonly #locale: RequestLocale;
  constructor(locale: RequestLocale) {
    super();
    this.#locale = locale;
  }
  handle() {
    this.#locale.use('en');
    return 'unreachable';
  }
}

class LeaveController extends Controller {
  handle() {
    return this.redirect().route('about');
  }
}

class UserController extends Controller {
  handle() {
    return view('shop/About', {});
  }
}

/** The errors the app reported, with their cause. */
const reports: ErrorReport[] = [];
class Collecting implements ErrorReporter {
  report(report: ErrorReport): void {
    reports.push(report);
  }
}
class Reporting {
  static errorReporters = [Collecting];
}

const routes = defineRoutes((Root) => {
  const localized = Root.authorize(everyone).localized();
  localized.get('/about', AboutController).name('about').sitemap();
  localized.get('/help/:slug', TranslatedController).name('help');
  localized.get('/use', UseLocaleController);
  localized.post('/leave', LeaveController);
  localized.fallback((ctx) => ({ locale: (ctx.params as Record<string, string>).locale, path: (ctx.params as Record<string, string>).path }));
  Root.authorize(everyone).get('/session/:locale', SessionLocaleController);
});

/** A localized page whose parameter can look like a locale (a user named EN). */
const userRoutes = defineRoutes((Root) => void Root.authorize(everyone).localized().get('/:username', UserController).name('user'));

/** The head a `<Head>` writes for a page: the canonical address and the versions, from the page object and `APP_URL`. */
const document = (page: PageObject, appUrl: string | undefined): string => {
  const at = (path: string) => new URL(path, appUrl).href;
  const alternates = Object.entries(page.alternates ?? {}).map(([language, path]) => `<link rel="alternate" hreflang="${language}" href="${at(path)}"/>`);
  return `<!doctype html><html lang="${page.locale}"><head><link rel="canonical" href="${at(page.url)}"/>${alternates.join('')}</head><body></body></html>`;
};
const renderer: PageRenderer = {
  render: async (page, _request, options) => document(page, options.appUrl),
  shell: async (page, _request, _nonce, appUrl) => document(page, appUrl),
};

async function boot({ env = {}, definitions = routes, override }: { env?: Record<string, string>; definitions?: RouteDefinitions; override?: (container: Container) => void } = {}) {
  const application = await createApplication({
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, I18nServiceProvider, Reporting],
    modules: [defineModule({ name: 'shop', routes: definitions })],
  }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', APP_URL, APP_LOCALE: 'de', APP_LOCALES: 'de,en', ...env }, override });
  const kernel = createHttpKernel(application, { renderer });
  const jar = new Map<string, string>();
  /** A browser: keeps its cookies. */
  const send = async (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await kernel.request(path, { ...init, headers: { cookie, ...init.headers } });
    for (const header of response.headers.getSetCookie()) {
      const [name, value] = header.split(';')[0]!.split('=') as [string, string];
      jar.set(name, value);
    }
    return response;
  };
  return { application, send };
}

const MODE = { APP_LOCALE_PREFIX: 'false' };
const visit = { [PAGE_HEADER]: PROTOCOL_VERSION };
const pageOf = async (response: Response) => (await response.json()) as PageObject & { props: Record<string, any> };
const html = { accept: 'text/html' };

describe('APP_LOCALE_PREFIX=false: the default locale without a prefix', () => {
  it('answers /about in the default locale, whatever the session and the browser say: no 302, no Vary: accept-language', async () => {
    const { send } = await boot({ env: MODE });
    await send('/session/en');
    const response = await send('/about', { headers: { ...visit, 'accept-language': 'en' } });
    expect(response.status).toBe(200);
    expect(await pageOf(response)).toMatchObject({ locale: 'de', props: { greeting: 'Hallo Ada' } });
    expect(response.headers.get('content-language')).toBe('de');
    expect(response.headers.get('vary') ?? '').not.toMatch(/accept-language/i);
    expect(response.headers.get('location')).toBeNull();
  });

  it('answers /en/about in English and sends /de/about?x=1 to /about?x=1 with a 301', async () => {
    const { send } = await boot({ env: MODE });
    expect(await pageOf(await send('/en/about', { headers: visit }))).toMatchObject({ locale: 'en', props: { greeting: 'Hello Ada' } });
    const moved = await send('/de/about?x=1');
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe('/about?x=1');
    expect(moved.headers.get('vary')).toBeNull();
  });

  it('puts the versions and the address form into the page object', async () => {
    const { send } = await boot({ env: MODE });
    const page = await pageOf(await send('/about?tab=1', { headers: visit }));
    expect(page.alternates).toEqual({ de: '/about?tab=1', en: '/en/about?tab=1', 'x-default': '/about?tab=1' });
    expect(page.urlLocales).toEqual({ unprefixed: 'de', supported: ['de', 'en'] });
    expect((await pageOf(await send('/en/about', { headers: visit }))).alternates).toEqual({ de: '/about', en: '/en/about', 'x-default': '/about' });
  });

  it('writes canonical, hreflang and x-default into the head — the default locale without a prefix', async () => {
    const { send } = await boot({ env: MODE });
    const german = await (await send('/about', { headers: html })).text();
    expect(german).toContain(`<link rel="canonical" href="${APP_URL}/about"/>`);
    expect(german).toContain(`<link rel="alternate" hreflang="de" href="${APP_URL}/about"/>`);
    expect(german).toContain(`<link rel="alternate" hreflang="en" href="${APP_URL}/en/about"/>`);
    expect(german).toContain(`<link rel="alternate" hreflang="x-default" href="${APP_URL}/about"/>`);
    const english = await (await send('/en/about', { headers: html })).text();
    expect(english).toContain(`<link rel="canonical" href="${APP_URL}/en/about"/>`);
    expect(english).toContain(`<link rel="alternate" hreflang="de" href="${APP_URL}/about"/>`);
  });

  it('lists both addresses in the sitemap, each naming both and x-default without a prefix', async () => {
    const { send } = await boot({ env: MODE });
    const xml = await (await send('/sitemap.xml')).text();
    expect([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1])).toEqual([`${APP_URL}/about`, `${APP_URL}/en/about`]);
    const links = [...xml.matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)"\/>/g)].map((match) => `${match[1]} ${match[2]}`);
    expect(links.slice(0, 3)).toEqual([`de ${APP_URL}/about`, `en ${APP_URL}/en/about`, `x-default ${APP_URL}/about`]);
    expect(links).toHaveLength(6);
  });

  it('builds the redirect of a page by the page’s own locale, and Router.url() by the one it is given', async () => {
    const { application, send } = await boot({ env: MODE });
    const german = await send('/leave', { method: 'POST', headers: { 'accept-language': 'en', 'sec-fetch-site': 'same-origin' } });
    expect(german.headers.get('location')).toBe('/about');
    const english = await send('/en/leave', { method: 'POST', headers: { 'accept-language': 'de', 'sec-fetch-site': 'same-origin' } });
    expect(english.headers.get('location')).toBe('/en/about');
    const router = application.container.make(Router);
    expect(router.url('about', { locale: 'de' })).toBe('/about');
    expect(router.url('about', { locale: 'en' })).toBe('/en/about');
  });

  it('makes RequestLocale.use() throw on the default locale’s address, as on any localized route', async () => {
    reports.length = 0;
    const { send } = await boot({ env: MODE });
    expect((await send('/use', { headers: visit })).status).toBe(500);
    expect(reports.map((report) => report.error.message)).toEqual([expect.stringContaining('RequestLocale.use(): this route is localized')]);
  });

  it('answers HEAD like GET, and a visit of the page protocol, with the 301 to the address without a prefix, kept an hour', async () => {
    const { send } = await boot({ env: MODE });
    for (const init of [{ method: 'HEAD' }, { headers: visit }, {}]) {
      const moved = await send('/de/about', init);
      expect(moved.status).toBe(301);
      expect(moved.headers.get('location')).toBe('/about');
      expect(moved.headers.get('cache-control')).toBe('max-age=3600');
    }
  });

  it('answers a POST to the prefixed address of the default locale with a 404 and no location', async () => {
    const { send } = await boot({ env: MODE });
    const response = await send('/de/leave', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it('names translated paths without a prefix for the default locale: de, and x-default of another locale', async () => {
    const { send } = await boot({ env: MODE });
    const page = await pageOf(await send('/help/erste-schritte?tab=1', { headers: visit }));
    expect(page.alternates).toEqual({ en: '/en/help/getting-started?tab=1', de: '/help/erste-schritte?tab=1', 'x-default': '/en/help/getting-started?tab=1' });
  });

  it('gives a localized fallback at the root the default locale for /x', async () => {
    const { send } = await boot({ env: MODE });
    expect(await (await send('/x')).json()).toEqual({ locale: 'de', path: 'x' });
    expect(await (await send('/en/x')).json()).toEqual({ locale: 'en', path: 'x' });
  });

  it('keeps the prefix of a page whose address without one would be a locale (a user named EN)', async () => {
    const { send } = await boot({ env: MODE, definitions: userRoutes });
    const page = await pageOf(await send('/de/EN', { headers: visit }));
    expect(page.alternates).toEqual({ de: '/de/EN', en: '/en/EN', 'x-default': '/de/EN' });
    expect((await send('/EN', { headers: visit })).status).toBe(404);
    expect((await pageOf(await send('/ada', { headers: visit }))).alternates).toEqual({ de: '/ada', en: '/en/ada', 'x-default': '/ada' });
  });

  it('with one language, answers /about and sends /en/about there', async () => {
    const { send } = await boot({ env: { ...MODE, APP_LOCALE: 'en', APP_LOCALES: 'en' } });
    expect((await send('/about', { headers: visit })).status).toBe(200);
    const moved = await send('/en/about');
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe('/about');
  });

  it('takes the spelling of APP_LOCALES for the address of a regional default (de-AT)', async () => {
    const { application, send } = await boot({ env: { ...MODE, APP_LOCALE: 'de-at', APP_LOCALES: 'de-AT,de,en' } });
    expect(application.container.make(Locales).unprefixed).toBe('de-AT');
    expect(await pageOf(await send('/about', { headers: visit }))).toMatchObject({ locale: 'de-AT', alternates: { 'de-AT': '/about', de: '/de/about', en: '/en/about', 'x-default': '/about' } });
    expect((await send('/de-AT/about')).headers.get('location')).toBe('/about');
    expect((await pageOf(await send('/de/about', { headers: visit }))).locale).toBe('de');
  });
});

describe('without APP_LOCALE_PREFIX: as before', () => {
  it('sends /about to the visitor’s locale with a 302 nobody caches', async () => {
    const { send } = await boot();
    const response = await send('/about', { headers: { 'accept-language': 'en' } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/en/about');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toMatch(/accept-language.*cookie|cookie.*accept-language/);
  });

  it('answers /de/about itself, with the versions as before', async () => {
    const { application, send } = await boot();
    const response = await send('/de/about', { headers: visit });
    expect(response.status).toBe(200);
    const page = await pageOf(response);
    expect(page.alternates).toEqual({ de: '/de/about', en: '/en/about', 'x-default': '/about' });
    expect(page.urlLocales).toBeUndefined();
    expect(application.container.make(Locales).unprefixed).toBeUndefined();
  });
});

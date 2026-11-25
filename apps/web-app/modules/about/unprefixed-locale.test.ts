import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

// APP_LOCALE_PREFIX=false: `en`, the default of the app, answers without a prefix; `de` keeps its own.
let app: TestApp;
let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());
beforeEach(async () => {
  app = await createTestApp(application, { ssr: true, ssrServer: server, env: { APP_LOCALE_PREFIX: 'false' } });
});

const document = { headers: { accept: 'text/html' } };

describe('the default locale without a prefix', () => {
  it('answers the about page in the default language at /about, and the other language under its prefix', async () => {
    const english = await app.navigating().get('/about', { headers: { 'accept-language': 'de' } }).assertOk().assertPage('about/Index');
    expect(english.page()!.locale).toBe('en');
    expect(english.page()!.alternates).toEqual({ en: '/about', de: '/de/about', 'x-default': '/about' });
    expect(english.headers.get('content-language')).toBe('en');
    const german = await app.navigating().get('/de/about', { headers: { 'accept-language': 'en' } }).assertOk().assertPage('about/Index');
    expect(german.page()!.locale).toBe('de');
    expect(german.headers.get('content-language')).toBe('de');
    expect(german.page()!.alternates).toEqual({ en: '/about', de: '/de/about', 'x-default': '/about' });
  });

  it('does not ask the session or the browser for the language of /about', async () => {
    const chosen = await app.withSession({ locale: 'de' }).get('/about', { headers: { 'accept-language': 'de' } }).assertOk();
    expect(chosen.headers.get('content-language')).toBe('en');
    // The page is a localized page like /de/about: the same Vary and Cache-Control, no Vary on the language, no redirect's no-store.
    const prefixed = await app.withSession({ locale: 'de' }).get('/de/about', { headers: { 'accept-language': 'de' } });
    expect(chosen.headers.get('vary')).toBe(prefixed.headers.get('vary'));
    expect(chosen.headers.get('vary') ?? '').not.toMatch(/accept-language|cookie/i);
    expect(chosen.headers.get('cache-control')).toBe(prefixed.headers.get('cache-control'));
    expect(chosen.headers.get('cache-control') ?? '').not.toMatch(/no-store/);
    // With a session both pages send the web group's CSRF cookie and nothing else: the choice of language is no cookie.
    const names = (response: { headers: Headers }) => response.headers.getSetCookie().map((cookie) => cookie.split('=')[0]);
    expect([names(chosen), names(prefixed)]).toEqual([['XSRF-TOKEN'], ['XSRF-TOKEN']]);
  });

  it('sends the prefixed address of the default language to the page for an hour', async () => {
    const response = await app.get('/en/about?tab=1');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/about?tab=1');
    expect(response.headers.get('cache-control')).toBe('max-age=3600');
    expect(response.headers.has('set-cookie')).toBe(false);
    const head = await app.request('HEAD', '/en/about');
    expect([head.status, head.headers.get('location')]).toEqual([301, '/about']);
  });

  it('tells the browser how the app prefixes its locales, so a link built there takes the address of the page', async () => {
    const page = (await app.navigating().get('/de/about').assertOk()).page()!;
    expect(page.urlLocales).toEqual({ unprefixed: 'en', supported: ['en', 'de'] });
  });

  it('writes canonical and hreflang by the addresses of the mode in the head the React Head renders', async () => {
    const english = await app.get('/about/features/typed-routes', document).assertOk().assertServerRendered();
    english.assertSee('<link rel="canonical" href="http://localhost/about/features/typed-routes"');
    english.assertSee('hreflang="en" href="http://localhost/about/features/typed-routes"');
    english.assertSee('hreflang="de" href="http://localhost/de/about/features/typed-routes"');
    english.assertSee('hreflang="x-default" href="http://localhost/about/features/typed-routes"');
    const german = await app.get('/de/about', document).assertOk().assertServerRendered();
    german.assertSee('<link rel="canonical" href="http://localhost/de/about"');
    german.assertSee('hreflang="x-default" href="http://localhost/about"');
  });

  it('builds the links and the language switcher of a page by its language', async () => {
    const english = await app.get('/about/features/typed-routes', document).assertOk().assertServerRendered();
    english.assertSee('href="/about"');
    english.assertSee('<a href="/de/about/features/typed-routes" hrefLang="de" lang="de">Deutsch</a>');
    const german = await app.get('/de/about/features/typed-routes', document).assertOk().assertServerRendered();
    german.assertSee('href="/de/about"');
    german.assertSee('<a href="/about/features/typed-routes" hrefLang="en" lang="en">English</a>');
  });

  it('lists the pages of the default language without a prefix in the sitemap, with x-default at the same address', async () => {
    const response = await app.get('/sitemap.xml').assertOk();
    const locs = [...response.body.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
    expect(locs).toContain('http://localhost/about');
    expect(locs).toContain('http://localhost/de/about');
    expect(locs).not.toContain('http://localhost/en/about');
    const english = response.body.split('<url>').find((entry) => entry.startsWith('<loc>http://localhost/about</loc>'))!;
    expect(english).toContain('<xhtml:link rel="alternate" hreflang="en" href="http://localhost/about"/>');
    expect(english).toContain('<xhtml:link rel="alternate" hreflang="de" href="http://localhost/de/about"/>');
    expect(english).toContain('<xhtml:link rel="alternate" hreflang="x-default" href="http://localhost/about"/>');
  });

  it('serves the localized fallback of the help pages in the default language at /help, with the versions it names', async () => {
    const page = await app.navigating().get('/help/getting-started').assertOk().assertPage('help/Show');
    expect(page.page()!.locale).toBe('en');
    expect(page.page()!.alternates).toEqual({ en: '/help/getting-started', de: '/de/help/erste-schritte', 'x-default': '/help/getting-started' });
    await app.navigating().get('/de/help/erste-schritte').assertOk().assertPage('help/Show');
    const moved = await app.get('/en/help/getting-started');
    expect([moved.status, moved.headers.get('location')]).toEqual([301, '/help/getting-started']);
    // Another language's slug on the default address leads to the page in the default language.
    const other = await app.get('/help/erste-schritte');
    expect([other.status, other.headers.get('location')]).toEqual([301, '/help/getting-started']);
  });

  it('keeps a route of another module ahead of the fallback at its address, and answers a nested page at its bare address', async () => {
    await app.navigating().get('/help/contact').assertOk().assertPage('support/Contact');
    const moved = await app.get('/en/help/contact');
    expect([moved.status, moved.headers.get('location')]).toEqual([301, '/help/contact']);
    // Without the mode the same path is a 302 to the visitor's language.
    const feature = await app.get('/about/features/typed-routes');
    expect(feature.status).toBe(200);
  });
});

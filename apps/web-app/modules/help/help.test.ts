import { Router } from '@marmeon/http';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { HelpPages } from './HelpPages.ts';

let app: TestApp;
let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());
beforeEach(async () => {
  app = await createTestApp(application, { ssr: true, ssrServer: server });
});

describe('the help pages', () => {
  it('lists the pages at /en/help and /de/help, in each language, for a guest', async () => {
    const english = await app.navigating().get('/en/help').assertOk().assertPage('help/Show');
    const props = english.page()!.props as { page: unknown; pages: { path: string; title: string }[] };
    expect(props.page).toBeNull();
    expect(props.pages.map((page) => page.path)).toEqual(['getting-started', 'getting-started/install', 'accounts/passkeys']);
    const germanPaths = ((await app.navigating().get('/de/help').assertOk().assertPage('help/Show')).page()!.props as typeof props).pages.map((page) => page.path);
    expect(germanPaths).toEqual(['erste-schritte', 'erste-schritte/installation', 'konto/passkeys']);
    expect(english.page()!.locale).toBe('en');
    const german = await app.navigating().get('/de/help').assertOk().assertPage('help/Show');
    expect((german.page()!.props as typeof props).pages[0]!.title).toBe('Erste Schritte');
    expect(german.page()!.locale).toBe('de');
  });

  it('shows a page and a nested page by the rest of the path, in the language of the address', async () => {
    const page = await app.navigating().get('/en/help/getting-started').assertOk().assertPage('help/Show');
    expect((page.page()!.props.page as { title: string }).title).toBe('Getting started');
    const german = await app.navigating().get('/de/help/erste-schritte/installation').assertOk().assertPage('help/Show');
    expect((german.page()!.props.page as { path: string; title: string })).toMatchObject({ path: 'erste-schritte/installation', title: 'Installation' });
    await app.navigating().get('/en/help/accounts/passkeys').assertOk();
  });

  it('answers 404 for a page the help does not have, and for a language the app lacks', async () => {
    await app.navigating().get('/en/help/no-such-page').assertNotFound();
    await app.navigating().get('/de/help/erste-schritte/installation/more').assertNotFound();
    await app.navigating().get('/fr/help/getting-started').assertNotFound();
  });

  it('answers 404 for a path with an empty segment or an encoded slash, before the controller runs', async () => {
    await app.navigating().get('/de/help/erste-schritte%2Finstallation').assertNotFound();
    await app.navigating().get('/de/help//erste-schritte').assertNotFound();
    await app.navigating().get('/de/help/erste-schritte//installation').assertNotFound();
  });

  it('sends a trailing slash to the page without it', async () => {
    const response = await app.get('/de/help/erste-schritte/installation/');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/de/help/erste-schritte/installation');
  });

  it('sends the address without a language to the visitor\'s, for no shared cache', async () => {
    const response = await app.get('/help/getting-started/install', { headers: { 'accept-language': 'de' } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/de/help/getting-started/install');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('accept-language, cookie');
    expect((await app.get('/help', { headers: { 'accept-language': 'en' } })).headers.get('location')).toBe('/en/help');
  });

  it('sends an address it would redirect to a page that does not exist to a 404 there: the double hop', async () => {
    const hop = await app.get('/help/no-such-page', { headers: { 'accept-language': 'de' } });
    expect(hop.headers.get('location')).toBe('/de/help/no-such-page');
    await app.navigating().get('/de/help/no-such-page').assertNotFound();
  });

  it('refuses a path that could leave the site before it redirects', async () => {
    for (const path of ['//evil.example/x', '/help//x', '/a%2Fb', '/%5Cevil.example']) {
      const response = await app.get(path);
      expect([path, response.status, response.headers.get('location')]).toEqual([path, 404, null]);
    }
  });

  it('builds the URL of a page from its path, one segment at a time, and the language as a parameter', () => {
    const router = app.application.container.make(Router);
    expect(router.url('help.page', { locale: 'de', path: 'erste-schritte/installation' })).toBe('/de/help/erste-schritte/installation');
    expect(router.url('help.page', { locale: 'en' })).toBe('/en/help');
    expect(() => router.url('help.page', { locale: 'en', path: 'a//b' })).toThrow('cannot be');
    // @ts-expect-error — a number is no rest of the path.
    expect(() => router.url('help.page', { locale: 'en', path: 7 })).toThrow('as a string');
  });

  it('yields to a route of a module that loads after it, and keeps every other path', async () => {
    await app.navigating().get('/en/help/contact').assertOk().assertPage('support/Contact');
    await app.navigating().get('/de/help/erste-schritte').assertOk().assertPage('help/Show');
    expect((await app.get('/help/contact', { headers: { 'accept-language': 'de' } })).headers.get('location')).toBe('/de/help/contact');
    const router = app.application.container.make(Router);
    expect(router.fallbacks.map((route) => route.path)).toEqual(['/:locale/help/:path*', '/help/:path*']);
  });

  it('has no page on a path a route or the framework answers: the fallback would never get it', () => {
    const router = app.application.container.make(Router);
    for (const locale of ['en', 'de']) {
      for (const page of new HelpPages().all(locale)) expect(router.claimedBy(`/${locale}/help/${page.path}`), page.path).toBeUndefined();
    }
    expect(router.claimedBy('/en/help/contact')).toMatchObject({ by: 'route' });
    expect(router.claimedBy('/en/help/a//b')).toEqual({ by: 'invalid' });
  });

  it('lists its pages in the sitemap in each language, each at its own address with the versions it names', async () => {
    const xml = (await app.get('/sitemap.xml').assertOk()).body;
    for (const locale of ['en', 'de']) expect(xml).toContain(`/${locale}/help</loc>`);
    // The overview's x-default is the one its head names.
    const overview = xml.split('<url>').find((entry) => entry.startsWith('<loc>http://localhost/de/help</loc>'))!;
    expect(overview).toContain('<xhtml:link rel="alternate" hreflang="x-default" href="http://localhost/help"/>');
    const german = xml.split('<url>').find((entry) => entry.startsWith('<loc>http://localhost/de/help/erste-schritte/installation</loc>'))!;
    expect(german).toContain('<xhtml:link rel="alternate" hreflang="en" href="http://localhost/en/help/getting-started/install"/>');
    expect(german).toContain('<xhtml:link rel="alternate" hreflang="de" href="http://localhost/de/help/erste-schritte/installation"/>');
    expect(german).toContain('<xhtml:link rel="alternate" hreflang="x-default" href="http://localhost/en/help/getting-started/install"/>');
    expect(xml).not.toContain('/de/help/getting-started');
    expect(xml).not.toContain('/en/help/erste-schritte');
  });

  it('names the other language\'s address in the head and the language switch, and the English page as x-default', async () => {
    const response = await app.get('/en/help/getting-started', { headers: { accept: 'text/html' } }).assertServerRendered();
    const tag = (attributes: string) => `<link ${attributes} data-marmeon-head="ssr"/>`;
    response
      .assertSee(tag('rel="alternate" hreflang="en" href="http://localhost/en/help/getting-started"'))
      .assertSee(tag('rel="alternate" hreflang="de" href="http://localhost/de/help/erste-schritte"'))
      .assertSee(tag('rel="alternate" hreflang="x-default" href="http://localhost/en/help/getting-started"'))
      .assertSee('href="/de/help/erste-schritte"');
    const german = await app.navigating().get('/de/help/konto/passkeys').assertOk();
    expect(german.page()!.alternates).toEqual({ en: '/en/help/accounts/passkeys', de: '/de/help/konto/passkeys', 'x-default': '/en/help/accounts/passkeys' });
  });

  it('keeps the versions the framework derives on the overview', async () => {
    const overview = await app.navigating().get('/de/help').assertOk();
    expect(overview.page()!.alternates).toEqual({ en: '/en/help', de: '/de/help', 'x-default': '/help' });
  });

  it('sends another language\'s address of a page to its own, and an address in no language to a 404', async () => {
    const foreign = await app.get('/de/help/getting-started');
    expect(foreign.status).toBe(301);
    expect(foreign.headers.get('location')).toBe('/de/help/erste-schritte');
    expect((await app.get('/en/help/erste-schritte/installation')).headers.get('location')).toBe('/en/help/getting-started/install');
    const hop = await app.get('/help/getting-started', { headers: { 'accept-language': 'de' } });
    expect(hop.headers.get('location')).toBe('/de/help/getting-started');
    await app.navigating().get('/de/help/gibt-es-nicht').assertNotFound();
  });

  it('never gives a missing asset, another method or a framework path to the help', async () => {
    expect((await app.get('/assets/missing.js')).status).toBe(404);
    expect((await app.get('/_marmeon/missing')).status).toBe(404);
    expect((await app.post('/en/help/getting-started', {})).status).toBe(404);
  });

  it('starts no session for a guest who only reads a page', async () => {
    const response = await app.get('/en/help/getting-started');
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

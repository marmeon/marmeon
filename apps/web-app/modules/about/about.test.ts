import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { FeatureCatalog } from './FeatureCatalog.ts';

let app: TestApp;
let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());
beforeEach(async () => {
  app = await createTestApp(application, { ssr: true, ssrServer: server });
});

describe('the sitemap', () => {
  it('lists the about page and every feature in each language, to a guest without a cookie', async () => {
    const response = await app.get('/sitemap.xml').assertOk();
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.has('set-cookie')).toBe(false);
    const locs = [...response.body.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
    const features = ['typed-routes', 'instant-visits', 'server-rendering', 'translations'];
    expect(locs).toEqual([
      'http://localhost/en/about',
      'http://localhost/de/about',
      ...features.flatMap((feature) => [`http://localhost/en/about/features/${feature}`, `http://localhost/de/about/features/${feature}`]),
    ]);
    expect(response.body).toContain('<loc>http://localhost/en/about/features/typed-routes</loc><lastmod>2026-03-02</lastmod>');
  });

  it('names every language of a page in its entries, and the address without one as x-default', async () => {
    const response = await app.get('/sitemap.xml').assertOk();
    expect(response.body).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    const german = response.body.split('<url>').find((entry) => entry.startsWith('<loc>http://localhost/de/about</loc>'))!;
    expect(german).toContain('<xhtml:link rel="alternate" hreflang="en" href="http://localhost/en/about"/>');
    expect(german).toContain('<xhtml:link rel="alternate" hreflang="de" href="http://localhost/de/about"/>');
    expect(german).toContain('<xhtml:link rel="alternate" hreflang="x-default" href="http://localhost/about"/>');
  });

  it('names the sitemap in robots.txt', async () => {
    const response = await app.get('/robots.txt').assertOk();
    expect(response.body).toBe('User-agent: *\nDisallow: /_marmeon/\n\nSitemap: http://localhost/sitemap.xml\n');
  });
});

describe('the public pages', () => {
  it('speaks the language of the URL, whatever the visitor’s browser asks for', async () => {
    const german = await app.navigating().get('/de/about', { headers: { 'accept-language': 'en' } }).assertOk().assertPage('about/Index');
    expect(german.page()!.locale).toBe('de');
    expect(german.page()!.alternates).toEqual({ en: '/en/about', de: '/de/about', 'x-default': '/about' });
    expect(german.headers.get('content-language')).toBe('de');
    expect(german.headers.get('vary') ?? '').not.toMatch(/accept-language/i);
    const english = await app.navigating().get('/en/about', { headers: { 'accept-language': 'de' } }).assertOk();
    expect(english.page()!.locale).toBe('en');
    expect(english.headers.get('content-language')).toBe('en');
  });

  it('sends the address without a language to the visitor’s, for no shared cache', async () => {
    const response = await app.get('/about', { headers: { 'accept-language': 'de' } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/de/about');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('accept-language, cookie');
    expect((await app.get('/about/features/typed-routes')).headers.get('location')).toMatch(/^\/(en|de)\/about\/features\/typed-routes$/);
  });

  it('answers 404 for a language the app does not have', async () => {
    await app.navigating().get('/fr/about').assertNotFound();
    await app.navigating().get('/DE/about').assertNotFound();
  });

  it('shows the list of features to a guest', async () => {
    const response = await app.navigating().get('/en/about').assertOk().assertPage('about/Index');
    expect((response.page()!.props as { auth?: { user?: unknown } }).auth?.user ?? null).toBeNull();
    const { features } = response.page()!.props as { features: { slug: string }[] };
    expect(features.map((feature) => feature.slug)).toContain('typed-routes');
    expect(features[0]).toEqual({ slug: 'typed-routes' });
  });

  it('shows one feature to a guest', async () => {
    const response = await app.navigating().get('/en/about/features/typed-routes').assertOk().assertPage('about/Feature');
    expect(response.page()!.props.feature).toEqual({ slug: 'typed-routes', updatedAt: '2026-03-02T09:00:00Z' });
  });

  it('answers 404 for a slug the catalog does not know', async () => {
    await app.navigating().get('/en/about/features/no-such-feature').assertNotFound();
  });

  it('answers 404 for a slug the route constraint rejects, before the controller runs', async () => {
    const find = vi.spyOn(FeatureCatalog.prototype, 'find');
    try {
      await app.navigating().get('/en/about/features/TYPED-ROUTES').assertNotFound();
      await app.navigating().get('/en/about/features/typed_routes').assertNotFound();
      expect(find).not.toHaveBeenCalled();
      await app.navigating().get('/en/about/features/typed-routes').assertOk();
      expect(find).toHaveBeenCalledOnce();
    } finally {
      find.mockRestore();
    }
  });
});

describe('the public pages in search results and link previews', () => {
  const page = { headers: { accept: 'text/html' } };

  it('describes a feature: description, canonical and Open Graph from APP_URL, a card', async () => {
    await app
      .get('/en/about/features/typed-routes', page)
      .assertServerRendered()
      .assertSee('<title data-marmeon-head="ssr">Typed routes — Marmeon</title>')
      .assertSee('<meta name="description" content="Route names and parameters are checked by the compiler, in controllers and views alike." data-marmeon-head="ssr"/>')
      .assertSee('<link rel="canonical" href="http://localhost/en/about/features/typed-routes" data-marmeon-head="ssr"/>')
      .assertSee('<meta property="og:title" content="Typed routes" data-marmeon-head="ssr"/>')
      .assertSee('<meta property="og:url" content="http://localhost/en/about/features/typed-routes" data-marmeon-head="ssr"/>')
      .assertSee('<meta property="article:modified_time" content="2026-03-02T09:00:00Z" data-marmeon-head="ssr"/>')
      .assertSee('<meta name="twitter:card" content="summary" data-marmeon-head="ssr"/>');
  });

  it('gives a feature as structured data, in a block that text cannot leave', async () => {
    const response = await app.get('/en/about/features/typed-routes', page).assertServerRendered();
    const blocks = [...response.body.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toContain('<');
    expect(JSON.parse(blocks[0]!)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: 'Typed routes',
      description: 'Route names and parameters are checked by the compiler, in controllers and views alike.',
      dateModified: '2026-03-02T09:00:00Z',
      publisher: { '@type': 'Organization', name: 'Marmeon' },
    });
  });

  it('describes the list, and a foreign Host does not reach the head', async () => {
    const response = await app.get('/en/about', { headers: { ...page.headers, host: 'evil.example' } }).assertServerRendered();
    response.assertSee('<link rel="canonical" href="http://localhost/en/about" data-marmeon-head="ssr"/>').assertSee('<meta property="og:site_name" content="Marmeon" data-marmeon-head="ssr"/>');
    expect(response.body).not.toContain('evil.example');
  });
});

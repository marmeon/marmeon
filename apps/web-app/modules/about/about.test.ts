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

describe('the public pages', () => {
  it('shows the list of features to a guest', async () => {
    const response = await app.navigating().get('/about').assertOk().assertPage('about/Index');
    expect((response.page()!.props as { auth?: { user?: unknown } }).auth?.user ?? null).toBeNull();
    const { features } = response.page()!.props as { features: { slug: string }[] };
    expect(features.map((feature) => feature.slug)).toContain('typed-routes');
    expect(features[0]).toEqual({ slug: 'typed-routes' });
  });

  it('shows one feature to a guest', async () => {
    const response = await app.navigating().get('/about/features/typed-routes').assertOk().assertPage('about/Feature');
    expect(response.page()!.props.feature).toEqual({ slug: 'typed-routes', updatedAt: '2026-03-02T09:00:00Z' });
  });

  it('answers 404 for a slug the catalog does not know', async () => {
    await app.navigating().get('/about/features/no-such-feature').assertNotFound();
  });

  it('answers 404 for a slug the route constraint rejects, before the controller runs', async () => {
    const find = vi.spyOn(FeatureCatalog.prototype, 'find');
    try {
      await app.navigating().get('/about/features/TYPED-ROUTES').assertNotFound();
      await app.navigating().get('/about/features/typed_routes').assertNotFound();
      expect(find).not.toHaveBeenCalled();
      await app.navigating().get('/about/features/typed-routes').assertOk();
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
      .get('/about/features/typed-routes', page)
      .assertServerRendered()
      .assertSee('<title data-marmeon-head="ssr">Typed routes — Marmeon</title>')
      .assertSee('<meta name="description" content="Route names and parameters are checked by the compiler, in controllers and views alike." data-marmeon-head="ssr"/>')
      .assertSee('<link rel="canonical" href="http://localhost/about/features/typed-routes" data-marmeon-head="ssr"/>')
      .assertSee('<meta property="og:title" content="Typed routes" data-marmeon-head="ssr"/>')
      .assertSee('<meta property="og:url" content="http://localhost/about/features/typed-routes" data-marmeon-head="ssr"/>')
      .assertSee('<meta property="article:modified_time" content="2026-03-02T09:00:00Z" data-marmeon-head="ssr"/>')
      .assertSee('<meta name="twitter:card" content="summary" data-marmeon-head="ssr"/>');
  });

  it('describes the list, and a foreign Host does not reach the head', async () => {
    const response = await app.get('/about', { headers: { ...page.headers, host: 'evil.example' } }).assertServerRendered();
    response.assertSee('<link rel="canonical" href="http://localhost/about" data-marmeon-head="ssr"/>').assertSee('<meta property="og:site_name" content="Marmeon" data-marmeon-head="ssr"/>');
    expect(response.body).not.toContain('evil.example');
  });
});

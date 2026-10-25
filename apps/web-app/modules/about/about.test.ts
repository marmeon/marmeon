import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { FeatureCatalog } from './FeatureCatalog.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application);
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

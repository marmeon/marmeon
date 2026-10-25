import type { Application } from '@marmeon/core';
import { defineRoutes, everyone, Router } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { RouteTypes } from './route-types.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

describe('RouteTypes — routes under a locale', () => {
  const router = new Router().load(
    { group: 'web' },
    defineRoutes((Route) => {
      const pages = Route.localized().authorize(everyone);
      pages.get('/about', () => 'about').name('about');
      pages.get('/about/features/:feature', () => 'feature').name('about.feature');
      Route.authorize(everyone).get('/impressum', () => 'legal').name('legal');
    }),
  );
  const types = new RouteTypes({ root: tempDir('marmeon-route-types-'), definition: {} } as unknown as Application, router);

  it('marks the entry with localized: true and writes the path with /:locale in front', async () => {
    const { source } = await types.render();
    expect(source).toContain("'about': { method: 'get'; path: '/:locale/about'; localized: true };");
    expect(source).toContain("'about.feature': { method: 'get'; path: '/:locale/about/features/:feature'; localized: true };");
    expect(source).toContain("'legal': { method: 'get'; path: '/impressum' };");
  });

  it('writes localized: true into the routes of the browser, and nothing for the route without its locale', () => {
    const { routes } = types.browserRoutes();
    expect(routes.about).toEqual({ method: 'get', path: '/:locale/about', localized: true });
    expect(routes.legal).toEqual({ method: 'get', path: '/impressum' });
    expect(Object.keys(routes)).toEqual(['about', 'about.feature', 'legal']);
  });
});

import type { Application } from '@marmeon/core';
import { defineRequest, defineRoutes, everyone, Router } from '@marmeon/router';
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

describe('RouteTypes — a controller no file of the app exports', () => {
  class PackagePageController {
    handle() {
      return 'page';
    }
  }
  class PackageFormController {
    static request = defineRequest({ schema: { '~standard': { version: 1, vendor: 'test', validate: () => ({ value: {} }) } } });
    handle() {
      return 'sent';
    }
  }
  const router = new Router().load(
    { group: 'web' },
    defineRoutes((Route) => {
      const open = Route.authorize(everyone);
      open.prefix('/pages').fallback(PackagePageController).name('pages.show');
      open.post('/send', PackageFormController).name('pages.send');
    }),
  );
  const types = new RouteTypes({ root: tempDir('marmeon-route-types-'), definition: {} } as unknown as Application, router);

  it('warns about one with a request, which has fields useForm would miss, and about none without', async () => {
    const { warnings } = await types.render();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[pages.send]');
    expect(warnings[0]).toContain('PackageFormController is not exported by any file of the app');
  });
});

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  class HiddenController {
    handle() {
      return 'hidden';
    }
  }
  const router = new Router().load(
    { group: 'web' },
    defineRoutes((Route) => {
      const open = Route.authorize(everyone);
      open.prefix('/pages').fallback(PackagePageController).name('pages.show');
      open.post('/send', PackageFormController).name('pages.send');
      open.get('/hidden', HiddenController).name('hidden.show');
    }),
  );
  const root = tempDir('marmeon-route-types-');
  mkdirSync(join(root, 'modules'));
  writeFileSync(join(root, 'modules/hidden.ts'), 'class HiddenController {}\nexport const other = 1;\n');
  const types = new RouteTypes({ root, definition: {} } as unknown as Application, router);

  it('warns about one the app declares and does not export, and about none that comes from a package', async () => {
    const { warnings } = await types.render();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[hidden.show]');
    expect(warnings[0]).toContain('HiddenController is not exported by any file of the app');
  });
});

describe('RouteTypes — the views of a package', () => {
  const router = new Router();

  function appWith(packages: Record<string, { marmeon: unknown; files: readonly string[] }>): string {
    const root = join(realpathSync(tempDir('marmeon-route-types-')), 'app');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module', dependencies: Object.fromEntries(Object.keys(packages).map((name) => [name, '1.0.0'])) }));
    for (const [name, { marmeon, files }] of Object.entries(packages)) {
      const dir = join(root, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: { './views/*': './dist/views/*.js', './area/client': './dist/area/client.js', './area/ssr': './dist/area/ssr.js', './lang/*': './dist/lang/*.js' }, marmeon }));
      for (const file of files) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), '');
      }
    }
    return root;
  }

  const render = (root: string) => new RouteTypes({ root, definition: {} } as unknown as Application, router).render();

  it('lists every view of a package as <namespace>::<view>', async () => {
    const root = appWith({
      '@acme/status-board': {
        marmeon: { namespace: 'status', entry: { client: './area/client', ssr: './area/ssr' }, views: './views' },
        files: ['dist/area/client.js', 'dist/area/ssr.js', 'dist/views/Index.js', 'dist/views/entries/Edit.js'],
      },
      '@acme/more': { marmeon: { namespace: 'more', entry: { client: './area/client', ssr: './area/ssr' }, views: './views' }, files: ['dist/views/Card.js'] },
    });
    const { source } = await render(root);
    expect(source).toContain("'status::Index': true;");
    expect(source).toContain("'status::entries/Edit': true;");
    expect(source).toContain("'more::Card': true;");
  });

  it('lists nothing for a package without views, or without a namespace', async () => {
    const root = appWith({
      '@acme/texts': { marmeon: { namespace: 'texts', lang: './lang' }, files: [] },
      '@acme/plain': { marmeon: { providers: [] }, files: ['dist/views/Card.js'] },
    });
    const { source } = await render(root);
    expect(source).not.toContain('::');
    expect(source).toContain("interface Views {\n    'system/errors/Error': true;\n  }");
  });

  it('writes a view name as a string literal, quoted', async () => {
    const root = appWith({ '@acme/status-board': { marmeon: { namespace: 'status', entry: { client: './area/client', ssr: './area/ssr' }, views: './views' }, files: ['dist/views/Index.js'] } });
    const { source } = await render(root);
    expect(source).toContain(`    ${JSON.stringify('status::Index').replaceAll('"', "'")}: true;`);
  });

  it('stops on a package that declares its views wrongly', async () => {
    const root = appWith({ '@acme/status-board': { marmeon: { namespace: 'App', views: './views' }, files: [] } });
    await expect(render(root)).rejects.toThrow('"namespace" is not valid');
  });
});

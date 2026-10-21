import { resolve } from 'node:path';
import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
import { Application, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { Router } from '@marmeon/router';
import { DocsConfig } from '../../config/docs.ts';
import { PUBLIC_GROUP } from '../site/SiteServiceProvider.ts';
import { DocsLines } from './DocsLines.ts';
import { DocsRepository } from './DocsRepository.ts';
import routes from './routes.ts';

/**
 * Loads the routes into the site's `public` group (while registering) and reads the pages while the app boots (a missing or
 * unlisted one stops the start). Not `web`: it would encrypt cookies and — with @marmeon/session — set the session's and the
 * CSRF cookie on every page (see SiteServiceProvider). The navigation is the routes' own middleware.
 */
export class DocsServiceProvider implements ServiceProvider {
  register(container: Container): void {
    // The routes while registering, not in boot(): `marmeon build` writes the route types from an app that boots nothing.
    container.make(Router).load({ group: PUBLIC_GROUP }, routes);
    container.singleton(DocsRepository, (c) => {
      const config = c.make(DocsConfig);
      return new DocsRepository({
        source: resolve(c.make(Application).root, config.source),
        watch: config.development,
        onReloadError: (error) => c.make(Logger).error(`The pages could not be read again — they stay as they were. ${error instanceof Error ? error.message : String(error)}`),
      });
    });
    // The release lines (no watching: a snapshot is frozen); none without pins.
    container.singleton(DocsLines, (c) => {
      const config = c.make(DocsConfig);
      const root = c.make(Application).root;
      return new DocsLines({ dir: resolve(root, config.lines), pins: resolve(root, config.linePins) });
    });
  }

  async boot(app: Application): Promise<void> {
    await app.container.make(DocsRepository).load();
    await app.container.make(DocsLines).load();

    const config = app.container.make(DocsConfig);
    app.container.make(RateLimiter).for('docs.search', (ctx) => Limit.perMinute(config.searchPerMinute).by(clientKey(ctx.ip)));
  }

  shutdown(app: Application): void {
    app.container.make(DocsRepository).close();
    app.container.make(DocsLines).close();
  }
}

import { resolve } from 'node:path';
import { Limit, RateLimiter } from '@bespokecore/cache';
import { Application, Logger, type Container, type ServiceProvider } from '@bespokecore/core';
import { CheckAssetVersion } from '@bespokecore/http';
import { MiddlewarePriority, Router } from '@bespokecore/router';
import { DocsConfig } from '../../config/docs.ts';
import { DocsRepository } from './DocsRepository.ts';
import { CachePublicly } from './middleware/CachePublicly.ts';
import { ShareNavigation } from './middleware/ShareNavigation.ts';
import routes from './routes.ts';

/** The middleware group of the docs' pages: public, without cookies, session or CSRF. */
export const DOCS_GROUP = 'docs';

/**
 * Reads the READMEs while the app boots (a missing or unlisted one stops the start) and loads the routes into a group of
 * their own: `web` would encrypt cookies and — with @bespokecore/session — start a session and set its cookie and the CSRF
 * cookie on every page. Public pages need none of it: the `docs` group checks the asset version (a client of an old build
 * reloads, E36-safe), shares the navigation and marks the answers cacheable.
 */
export class DocsServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(DocsRepository, (c) => {
      const config = c.make(DocsConfig);
      return new DocsRepository({
        source: resolve(c.make(Application).root, config.source),
        watch: config.development,
        onReloadError: (error) => c.make(Logger).error(`The READMEs could not be read again — the pages stay as they were. ${error instanceof Error ? error.message : String(error)}`),
      });
    });
  }

  async boot(app: Application): Promise<void> {
    await app.container.make(DocsRepository).load();

    const config = app.container.make(DocsConfig);
    app.container.make(RateLimiter).for('docs.search', (ctx) => Limit.perMinute(config.searchPerMinute).by(ctx.ip ?? ''));

    const router = app.container.make(Router);
    router.middleware
      .append(DOCS_GROUP, CachePublicly, MiddlewarePriority.encryptCookies - 50) // outermost: it sees the group's final answer
      .append(DOCS_GROUP, CheckAssetVersion, MiddlewarePriority.checkAssetVersion)
      .append(DOCS_GROUP, ShareNavigation, MiddlewarePriority.shareProps);
    router.load({ group: DOCS_GROUP }, routes);
  }

  shutdown(app: Application): void {
    app.container.make(DocsRepository).close();
  }
}

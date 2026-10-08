import { resolve } from 'node:path';
import { Limit, RateLimiter } from '@marmeon/cache';
import { Application, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { CheckAssetVersion, contentSecurityPolicy, type ContentSecurityPolicyOptions } from '@marmeon/http';
import { GLOBAL, MiddlewarePriority, Router } from '@marmeon/router';
import { DocsConfig } from '../../config/docs.ts';
import { DocsRepository } from './DocsRepository.ts';
import { CachePublicly } from './middleware/CachePublicly.ts';
import { SecurityHeaders } from './middleware/SecurityHeaders.ts';
import { ShareNavigation } from './middleware/ShareNavigation.ts';
import routes from './routes.ts';

/** The middleware group of the docs' pages: public, without cookies, session or CSRF. */
export const DOCS_GROUP = 'docs';

/**
 * The docs' Content-Security-Policy in production: scripts from this origin only. The pages are cached publicly
 * (`CachePublicly`), and a nonce — one per response (E147) — must never reach a shared cache, where everybody would get the
 * same one. They need none: the server renders no inline script (the page object is inert JSON, nothing streams, the code
 * blocks are spans), and the entry, its chunks and tab sync's chunk come from `/assets/` — `'self'`. The links test proves the
 * first for every page, the browser check the rest (0 violations).
 */
export const DOCS_CSP: ContentSecurityPolicyOptions = { scriptSrc: ["'self'"], frameAncestors: ["'none'"] };

/**
 * In development Vite's client, React Refresh's preamble and the devtools' bar are inline scripts: the strict default with a
 * nonce (E147) — pages are `no-cache` there, nothing is shared.
 */
export const DOCS_DEV_CSP: ContentSecurityPolicyOptions = { frameAncestors: ["'none'"] };

/**
 * Loads the routes into a group of their own (while registering) and reads the pages while the app boots (a missing or
 * unlisted one stops the start). A group of their own: `web` would encrypt cookies and — with @marmeon/session — start a session and set its cookie and the CSRF
 * cookie on every page. Public pages need none of it: the `docs` group checks the asset version (a client of an old build
 * reloads, E36-safe), shares the navigation and marks the answers cacheable.
 */
export class DocsServiceProvider implements ServiceProvider {
  register(container: Container): void {
    // The routes while registering, not in boot(): `marmeon build` writes the route types from an app that boots nothing (E187).
    container.make(Router).load({ group: DOCS_GROUP }, routes);
    container.singleton(DocsRepository, (c) => {
      const config = c.make(DocsConfig);
      return new DocsRepository({
        source: resolve(c.make(Application).root, config.source),
        watch: config.development,
        onReloadError: (error) => c.make(Logger).error(`The pages could not be read again — they stay as they were. ${error instanceof Error ? error.message : String(error)}`),
      });
    });
  }

  async boot(app: Application): Promise<void> {
    await app.container.make(DocsRepository).load();

    const config = app.container.make(DocsConfig);
    app.container.make(RateLimiter).for('docs.search', (ctx) => Limit.perMinute(config.searchPerMinute).by(ctx.ip ?? ''));

    const router = app.container.make(Router);
    // Global: the 404 page (no route, no group) gets the policy and the headers too.
    router.middleware.append(GLOBAL, SecurityHeaders).append(GLOBAL, contentSecurityPolicy(config.development ? DOCS_DEV_CSP : DOCS_CSP));
    router.middleware
      .append(DOCS_GROUP, CachePublicly, MiddlewarePriority.encryptCookies - 50) // outermost: it sees the group's final answer
      .append(DOCS_GROUP, CheckAssetVersion, MiddlewarePriority.checkAssetVersion)
      .append(DOCS_GROUP, ShareNavigation, MiddlewarePriority.shareProps);
  }

  shutdown(app: Application): void {
    app.container.make(DocsRepository).close();
  }
}

import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { CheckAssetVersion, contentSecurityPolicy, type ContentSecurityPolicyOptions, securityHeaders } from '@marmeon/http';
import { GLOBAL, MiddlewarePriority, Router } from '@marmeon/router';
import { SiteConfig } from '../../config/site.ts';
import { CachePublicly } from './middleware/CachePublicly.ts';
import { FATHOM_SCRIPT } from './fathom.ts';
import { ShareAnalytics } from './middleware/ShareAnalytics.ts';
import { ShareSite } from './middleware/ShareSite.ts';
import { SiteInfo } from './SiteInfo.ts';
import { SiteSnippets } from './SiteSnippets.ts';
import routes from './routes.ts';

/** The middleware group of the website's public pages: without cookies, session or CSRF. */
export const PUBLIC_GROUP = 'public';

/**
 * The Content-Security-Policy in production: scripts and styles from this origin only — no `style` attribute, no inline
 * `<style>`; the fonts and the stylesheet come from `/assets/`. The pages are cached publicly
 * (`CachePublicly`), and a nonce — one per response — must never reach a shared cache, where everybody would get the
 * same one. They need none: the server renders no inline script (the page object is inert JSON, nothing streams, the code
 * blocks are spans), and the entry, its chunks and tab sync's chunk come from `/assets/` — `'self'`.
 */
export const SITE_CSP: ContentSecurityPolicyOptions = { scriptSrc: ["'self'"], styleSrc: ["'self'"], frameAncestors: ["'none'"] };

/** The policy when Fathom Analytics is on: its script may load; the beacon goes out as an image or request, which the policy leaves open. */
export function siteCsp(fathom: boolean): ContentSecurityPolicyOptions {
  return fathom ? { ...SITE_CSP, scriptSrc: ["'self'", FATHOM_SCRIPT] } : SITE_CSP;
}

/**
 * In development Vite's client, React Refresh's preamble and the devtools' bar are inline scripts: the strict default with a
 * nonce — pages are `no-cache` there, nothing is shared.
 */
export const SITE_DEV_CSP: ContentSecurityPolicyOptions = { frameAncestors: ["'none'"] };

/**
 * Owns the `public` group and the answers' headers for the whole website: the landing's routes go into the group while
 * registering, other modules (the docs) load theirs into it. Not `web`: it would encrypt cookies and — with
 * @marmeon/session — set the session's and the CSRF cookie on every page, and a public cache would hand that cookie to
 * everybody. The group checks the asset version (a client of an old build reloads), shares the site's version and marks the
 * answers cacheable.
 */
export class SiteServiceProvider implements ServiceProvider {
  register(container: Container): void {
    // The routes while registering, not in boot(): `marmeon build` writes the route types from an app that boots nothing.
    container.make(Router).load({ group: PUBLIC_GROUP }, routes);
    container.singleton(SiteInfo, () => new SiteInfo(frameworkVersion()));
    container.singleton(SiteSnippets, () => new SiteSnippets());
  }

  async boot(app: Application): Promise<void> {
    // Read the version now: a manifest that cannot be found stops the start, not the first request.
    app.container.make(SiteInfo);
    await app.container.make(SiteSnippets).load();
    const config = app.container.make(SiteConfig);
    const router = app.container.make(Router);
    // Global: the 404 page (no route, no group) gets the policy and the headers too. HSTS comes from the proxy in front
    // (deploy/website/Caddyfile).
    router.middleware
      .append(GLOBAL, securityHeaders())
      .append(GLOBAL, contentSecurityPolicy(config.development ? SITE_DEV_CSP : siteCsp(config.fathomSite !== undefined)))
      .append(GLOBAL, ShareAnalytics);
    router.middleware
      .append(PUBLIC_GROUP, CachePublicly, MiddlewarePriority.encryptCookies - 50) // outermost: it sees the group's final answer
      .append(PUBLIC_GROUP, CheckAssetVersion, MiddlewarePriority.checkAssetVersion)
      .append(PUBLIC_GROUP, ShareSite, MiddlewarePriority.shareProps);
  }
}

/** The version of the framework this website runs on, from `@marmeon/core`'s manifest. */
function frameworkVersion(): string {
  const manifest = findPackageJSON('@marmeon/core', import.meta.url);
  if (manifest === undefined) throw new Error('The version of @marmeon/core could not be found.');
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
}

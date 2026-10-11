import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';
import { FATHOM_SITE_PATTERN } from '../modules/site/fathom.ts';

/** How long browsers and caches may keep a public page of the website. */
export const SiteConfig = defineConfig('site', {
  env: env({
    /**
     * `Cache-Control: public, max-age=…` of a page in seconds (the content changes only with a deploy; an `ETag` lets a
     * browser ask again cheaply after that). In development pages are `no-cache`: an edited page shows on the next visit.
     */
    SITE_CACHE_MAX_AGE: env.integer().min(0).default(300),
    /**
     * The Fathom Analytics site id (uppercase letters and digits). Empty: no analytics. Set, it is loaded in production only —
     * development and test never send a pageview — and the Content-Security-Policy names Fathom's origin for scripts.
     */
    SITE_FATHOM_SITE: env.string().regex(new RegExp(`^$|${FATHOM_SITE_PATTERN.source}`), 'must be a Fathom site id (uppercase letters and digits) or empty').default(''),
    NODE_ENV: env.string().default('production'),
  }),
  resolve: (e) => ({
    cacheMaxAge: e.SITE_CACHE_MAX_AGE,
    /** No long caching, and the strict nonce policy for Vite's inline scripts. */
    development: e.NODE_ENV === 'development',
    /** The Fathom site id, only where protections apply (production) and when one is set. */
    fathomSite: e.SITE_FATHOM_SITE !== '' && environment.isProtected({ NODE_ENV: e.NODE_ENV }) ? e.SITE_FATHOM_SITE : undefined,
  }),
});
export type SiteConfig = ConfigOf<typeof SiteConfig>;

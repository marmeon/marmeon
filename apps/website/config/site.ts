import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** How long browsers and caches may keep a public page of the website. */
export const SiteConfig = defineConfig('site', {
  env: env({
    /**
     * `Cache-Control: public, max-age=…` of a page in seconds (the content changes only with a deploy; an `ETag` lets a
     * browser ask again cheaply after that). In development pages are `no-cache`: an edited page shows on the next visit.
     */
    SITE_CACHE_MAX_AGE: env.integer().min(0).default(300),
    NODE_ENV: env.string().default('production'),
  }),
  resolve: (e) => ({
    cacheMaxAge: e.SITE_CACHE_MAX_AGE,
    /** No long caching, and the strict nonce policy for Vite's inline scripts. */
    development: e.NODE_ENV === 'development',
  }),
});
export type SiteConfig = ConfigOf<typeof SiteConfig>;

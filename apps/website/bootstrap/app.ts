import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import docs from '#modules/docs';
import site from '#modules/site';
import { AppConfig } from '../config/app.ts';

/**
 * The website: the landing page (`modules/site`) and Marmeon's documentation (`docs/*.md`, `modules/docs`) as a normal Marmeon
 * app (SSR, layouts, `<Link prefetch>`, a search route; no static export). Public pages without a session: the routes live in
 * the `public` group (see SiteServiceProvider).
 */
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [site, docs],
  // The browser learns the `site.*` and `docs.*` routes its code names (they are not in the `web` group, the default).
  clientRoutes: { include: ['site.*', 'docs.*'] },
});

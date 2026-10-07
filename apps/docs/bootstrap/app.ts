import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import docs from '#modules/docs';
import { AppConfig } from '../config/app.ts';

/**
 * The docs: Marmeon's READMEs as a normal Marmeon app (E114, E133 — SSR, layouts, `<Link prefetch>`, a search route;
 * no static export). Public pages without a session: the routes live in the `docs` group (see DocsServiceProvider).
 */
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [docs],
  // The browser learns the `docs.*` routes its code names (they are not in the `web` group, the default).
  clientRoutes: { include: ['docs.*'] },
});

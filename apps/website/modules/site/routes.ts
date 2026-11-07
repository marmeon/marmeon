import { defineRoutes, everyone } from '@marmeon/http';
import { ShowImprintController } from './controllers/ShowImprintController.ts';
import { ShowLandingController } from './controllers/ShowLandingController.ts';
import { ShowRobotsController } from './controllers/ShowRobotsController.ts';
import { ShowRenderClockController } from './controllers/ShowRenderClockController.ts';
import { ShowPrivacyController } from './controllers/ShowPrivacyController.ts';

/** Loaded into the `public` group by the SiteServiceProvider (not `defineModule({ routes })`, which is the `web` group). */
export default defineRoutes((Route) => {
  // The site's pages are public: the same for every visitor, and none binds a record. Decided for this file's routes only — a route
  // you add needs its own decision.
  const open = Route.authorize(everyone);
  open.get('/', ShowLandingController).name('site.home').sitemap();
  open.get('/imprint', ShowImprintController).name('site.imprint').sitemap();
  open.get('/privacy', ShowPrivacyController).name('site.privacy').sitemap();
  // An island, never visited (a direct request is a 404): the landing page loads it, public like the pages around it. Not in the sitemap.
  open.get('/islands/render-clock', ShowRenderClockController).name('site.render-clock');
  // Its own robots.txt, which wins over the framework's: the search is an endless URL space that crawlers should leave alone. The
  // sitemap is the framework's, made from the routes marked `.sitemap()`.
  open.get('/robots.txt', ShowRobotsController).name('site.robots');
});

import { defineRoutes, everyone } from '@marmeon/http';
import { ShowImprintController } from './controllers/ShowImprintController.ts';
import { ShowLandingController } from './controllers/ShowLandingController.ts';
import { ShowRobotsController } from './controllers/ShowRobotsController.ts';
import { ShowSitemapController } from './controllers/ShowSitemapController.ts';
import { ShowPrivacyController } from './controllers/ShowPrivacyController.ts';

/** Loaded into the `public` group by the SiteServiceProvider (not `defineModule({ routes })`, which is the `web` group). */
export default defineRoutes((Route) => {
  // The site's pages are public: the same for every visitor, and none binds a record. Decided for this file's routes only — a route
  // you add needs its own decision.
  const open = Route.authorize(everyone);
  open.get('/', ShowLandingController).name('site.home');
  open.get('/imprint', ShowImprintController).name('site.imprint');
  open.get('/privacy', ShowPrivacyController).name('site.privacy');
  open.get('/sitemap.xml', ShowSitemapController).name('site.sitemap');
  open.get('/robots.txt', ShowRobotsController).name('site.robots');
});

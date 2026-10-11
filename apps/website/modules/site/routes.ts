import { defineRoutes } from '@marmeon/http';
import { ShowImprintController } from './controllers/ShowImprintController.ts';
import { ShowLandingController } from './controllers/ShowLandingController.ts';
import { ShowPrivacyController } from './controllers/ShowPrivacyController.ts';

/** Loaded into the `public` group by the SiteServiceProvider (not `defineModule({ routes })`, which is the `web` group). */
export default defineRoutes((Route) => {
  Route.get('/', ShowLandingController).name('site.home');
  Route.get('/imprint', ShowImprintController).name('site.imprint');
  Route.get('/privacy', ShowPrivacyController).name('site.privacy');
});

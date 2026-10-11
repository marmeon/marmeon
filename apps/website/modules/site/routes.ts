import { defineRoutes } from '@marmeon/http';
import { ShowLandingController } from './controllers/ShowLandingController.ts';

/** Loaded into the `public` group by the SiteServiceProvider (not `defineModule({ routes })`, which is the `web` group). */
export default defineRoutes((Route) => {
  Route.get('/', ShowLandingController).name('site.home');
});

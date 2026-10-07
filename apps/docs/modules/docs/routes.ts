import { throttle } from '@marmeon/cache';
import { defineRoutes } from '@marmeon/http';
import { SearchController } from './controllers/SearchController.ts';
import { ShowGuideController } from './controllers/ShowGuideController.ts';
import { ShowHomeController } from './controllers/ShowHomeController.ts';
import { ShowPackageController } from './controllers/ShowPackageController.ts';
import { DocsRepository, GuideBinding } from './DocsRepository.ts';

/** Loaded into the `docs` group by the DocsServiceProvider (not `defineModule({ routes })`, which is the `web` group). */
export default defineRoutes((Route) => {
  Route.get('/', ShowHomeController).name('docs.home');
  // An unknown package is a 404: the repository is the route binder.
  Route.bind('name', DocsRepository).get('/packages/:name', ShowPackageController).name('docs.package');
  Route.bind('guide', GuideBinding).get('/guides/:guide', ShowGuideController).name('docs.guide');
  Route.middleware(throttle('docs.search')).get('/search', SearchController).name('docs.search');
});

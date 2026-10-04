import { throttle } from '@bespokecore/cache';
import { defineRoutes } from '@bespokecore/http';
import { SearchController } from './controllers/SearchController.ts';
import { ShowHomeController } from './controllers/ShowHomeController.ts';
import { ShowPackageController } from './controllers/ShowPackageController.ts';
import { DocsRepository } from './DocsRepository.ts';

/** Loaded into the `docs` group by the DocsServiceProvider (not `defineModule({ routes })`, which is the `web` group). */
export default defineRoutes((Route) => {
  Route.get('/', ShowHomeController).name('docs.home');
  // An unknown package is a 404: the repository is the route binder.
  Route.bind('name', DocsRepository).get('/packages/:name', ShowPackageController).name('docs.package');
  Route.middleware(throttle('docs.search')).get('/search', SearchController).name('docs.search');
});

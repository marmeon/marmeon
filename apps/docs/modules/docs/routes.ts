import { throttle } from '@marmeon/cache';
import { defineRoutes } from '@marmeon/http';
import { SearchController } from './controllers/SearchController.ts';
import { ShowDocController } from './controllers/ShowDocController.ts';
import { ShowHomeController } from './controllers/ShowHomeController.ts';
import { ShowPackageController } from './controllers/ShowPackageController.ts';
import { DocBinding, DocsRepository } from './DocsRepository.ts';

/** Loaded into the `docs` group by the DocsServiceProvider (not `defineModule({ routes })`, which is the `web` group). */
export default defineRoutes((Route) => {
  Route.get('/', ShowHomeController).name('docs.home');
  // An unknown page or package is a 404: the binders ask the repository.
  Route.bind('page', DocBinding).get('/docs/:page', ShowDocController).name('docs.page');
  Route.bind('name', DocsRepository).get('/packages/:name', ShowPackageController).name('docs.package');
  Route.middleware(throttle('docs.search')).get('/search', SearchController).name('docs.search');
});

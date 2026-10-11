import { throttle } from '@marmeon/cache';
import { defineRoutes } from '@marmeon/http';
import { SearchController } from './controllers/SearchController.ts';
import { ShowDocController } from './controllers/ShowDocController.ts';
import { ShowHomeController } from './controllers/ShowHomeController.ts';
import { DocBinding } from './DocsRepository.ts';

/** Loaded into the `docs` group by the DocsServiceProvider (not `defineModule({ routes })`, which is the `web` group). */
export default defineRoutes((Route) => {
  Route.get('/', ShowHomeController).name('docs.home');
  // An unknown page is a 404: the binder asks the repository.
  Route.bind('page', DocBinding).get('/docs/:page', ShowDocController).name('docs.page');
  Route.middleware(throttle('docs.search')).get('/search', SearchController).name('docs.search');
});

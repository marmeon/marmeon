import { throttle } from '@marmeon/cache';
import { defineRoutes } from '@marmeon/http';
import { SearchController } from './controllers/SearchController.ts';
import { ShowDocController } from './controllers/ShowDocController.ts';
import { ShowHomeController } from './controllers/ShowHomeController.ts';
import { ShowDocSourceController } from './controllers/ShowDocSourceController.ts';
import { DocBinding, DocSourceBinding } from './DocsRepository.ts';
import { ShareNavigation } from './middleware/ShareNavigation.ts';

/** Loaded into the `public` group by the DocsServiceProvider (not `defineModule({ routes })`, which is the `web` group). */
export default defineRoutes((Route) => {
  // Before `/docs/:page`, which would take `routing.md` as a slug; the constraint keeps any other path off this route. No navigation,
  // no throttle: the Markdown is in memory, like a page's HTML.
  Route.bind('file', DocSourceBinding).get('/docs/:file{[a-z0-9-]+\\.md}', ShowDocSourceController).name('docs.markdown');
  // The navigation (a few dozen entries) goes with the docs' pages only, not with the landing.
  Route.middleware(ShareNavigation).group((Route) => {
    Route.get('/docs', ShowHomeController).name('docs.home');
    // Before `/docs/:page`: the search is a reserved slug (the repository refuses a page of that name).
    Route.middleware(throttle('docs.search')).get('/docs/search', SearchController).name('docs.search');
    // An unknown page is a 404: the binder asks the repository.
    Route.bind('page', DocBinding).get('/docs/:page', ShowDocController).name('docs.page');
  });
});

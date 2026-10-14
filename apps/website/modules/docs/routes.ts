import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { SearchController } from './controllers/SearchController.ts';
import { ShowDocController } from './controllers/ShowDocController.ts';
import { ShowHomeController } from './controllers/ShowHomeController.ts';
import { ShowLlmsController } from './controllers/ShowLlmsController.ts';
import { ShowLlmsFullController } from './controllers/ShowLlmsFullController.ts';
import { ShowDocSourceController } from './controllers/ShowDocSourceController.ts';
import { DocBinding, DocSourceBinding } from './DocsRepository.ts';
import { ShareNavigation } from './middleware/ShareNavigation.ts';
import { VaryOnAccept } from './middleware/VaryOnAccept.ts';

/** Loaded into the `public` group by the DocsServiceProvider (not `defineModule({ routes })`, which is the `web` group). */
export default defineRoutes((Root) => {
  // The documentation is public: nobody signs in, and the pages and their Markdown are the same for every visitor. Decided for this
  // file's routes only — a route you add needs its own decision.
  const Route = Root.authorize(everyone);
  // Before `/docs/:page`, which would take `routing.md` as a slug; the constraint keeps any other path off this route. No navigation,
  // no throttle: the Markdown is in memory, like a page's HTML.
  Route.bind('file', DocSourceBinding, { public: true }).get('/docs/:file{[a-z0-9-]+\\.md}', ShowDocSourceController).name('docs.markdown');
  Route.get('/llms.txt', ShowLlmsController).name('docs.llms');
  Route.get('/llms-full.txt', ShowLlmsFullController).name('docs.llms-full');
  // The navigation (a few dozen entries) goes with the docs' pages only, not with the landing.
  Route.middleware(ShareNavigation).group((Route) => {
    // Markdown or HTML by `Accept` — caches must keep both apart.
    Route.middleware(VaryOnAccept).get('/docs', ShowHomeController).name('docs.home');
    // Before `/docs/:page`: the search is a reserved slug (the repository refuses a page of that name).
    Route.middleware(throttle('docs.search')).get('/docs/search', SearchController).name('docs.search');
    // An unknown page is a 404: the binder asks the repository.
    Route.middleware(VaryOnAccept).bind('page', DocBinding, { public: true }).get('/docs/:page', ShowDocController).name('docs.page');
  });
});

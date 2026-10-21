import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { SearchController } from './controllers/SearchController.ts';
import { ShowDocController } from './controllers/ShowDocController.ts';
import { ShowHomeController } from './controllers/ShowHomeController.ts';
import { ShowLlmsController } from './controllers/ShowLlmsController.ts';
import { ShowLlmsFullController } from './controllers/ShowLlmsFullController.ts';
import { ShowDocSourceController } from './controllers/ShowDocSourceController.ts';
import { LineBinding, LinePageBinding, LineSourceBinding } from './DocsLines.ts';
import { DocBinding, DocSourceBinding } from './DocsRepository.ts';
import { LINE_PATTERN } from './release-line.ts';
import { ShowLineDocController } from './controllers/ShowLineDocController.ts';
import { ShowLineDocSourceController } from './controllers/ShowLineDocSourceController.ts';
import { ShowLineHomeController } from './controllers/ShowLineHomeController.ts';
import { ShowLineLlmsController } from './controllers/ShowLineLlmsController.ts';
import { ShowLineLlmsFullController } from './controllers/ShowLineLlmsFullController.ts';
import { NoIndexLine } from './middleware/NoIndexLine.ts';
import { ShareNavigation } from './middleware/ShareNavigation.ts';
import { VaryOnAccept } from './middleware/VaryOnAccept.ts';

/** Loaded into the `public` group by the DocsServiceProvider (not `defineModule({ routes })`, which is the `web` group). */
export default defineRoutes((Route) => {
  // The documentation is public: nobody signs in, and the pages and their Markdown are the same for every visitor. Decided for this
  // file's routes only — a route you add needs its own decision.
  const open = Route.authorize(everyone);
  // Before `/docs/:page`, which would take `routing.md` as a slug; the constraint keeps any other path off this route. No navigation,
  // no throttle: the Markdown is in memory, like a page's HTML.
  // The release lines first: `/docs/0.3.x` would also be a slug for `/docs/:page`. The line, then its page, are looked up in what the boot
  // read (LineBinding, scopedBy) — nothing of the path reaches the file system. Whatever is not there is a 404; no search, no navigation
  // shared once (a line has its own, passed by its pages).
  const line = `:line{${LINE_PATTERN}}`;
  open.middleware(NoIndexLine).group((Route) => {
    Route.bind('line', LineBinding, { public: true }).get(`/docs/${line}/llms.txt`, ShowLineLlmsController).name('docs.line.llms');
    Route.bind('line', LineBinding, { public: true }).get(`/docs/${line}/llms-full.txt`, ShowLineLlmsFullController).name('docs.line.llms-full');
    Route.bind('line', LineBinding, { public: true })
      .bind('file', LineSourceBinding, { scopedBy: 'line', public: true })
      .get(`/docs/${line}/:file{[a-z0-9-]+\\.md}`, ShowLineDocSourceController)
      .name('docs.line.markdown');
    Route.middleware(VaryOnAccept).bind('line', LineBinding, { public: true }).get(`/docs/${line}`, ShowLineHomeController).name('docs.line.home');
    Route.middleware(VaryOnAccept)
      .bind('line', LineBinding, { public: true })
      .bind('page', LinePageBinding, { scopedBy: 'line', public: true })
      .get(`/docs/${line}/:page`, ShowLineDocController)
      .name('docs.line.page');
  });
  open.bind('file', DocSourceBinding, { public: true }).get('/docs/:file{[a-z0-9-]+\\.md}', ShowDocSourceController).name('docs.markdown');
  open.get('/llms.txt', ShowLlmsController).name('docs.llms');
  open.get('/llms-full.txt', ShowLlmsFullController).name('docs.llms-full');
  // The navigation (a few dozen entries) goes with the docs' pages only, not with the landing.
  open.middleware(ShareNavigation).group((Route) => {
    // Markdown or HTML by `Accept` — caches must keep both apart.
    Route.middleware(VaryOnAccept).get('/docs', ShowHomeController).name('docs.home');
    // Before `/docs/:page`: the search is a reserved slug (the repository refuses a page of that name).
    Route.middleware(throttle('docs.search')).get('/docs/search', SearchController).name('docs.search');
    // An unknown page is a 404: the binder asks the repository.
    Route.middleware(VaryOnAccept).bind('page', DocBinding, { public: true }).get('/docs/:page', ShowDocController).name('docs.page');
  });
});

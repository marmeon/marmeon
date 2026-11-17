import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { regionOf } from '@marmeon/http/protocol';
import { rules as r } from '@marmeon/validation';
import { DocsRepository } from '../DocsRepository.ts';
import { SEARCH_SCOPES, type SearchResults } from '../search.ts';

/**
 * The search's query. Longer than 100 characters is invalid — and an invalid field falls back to its default (a URL never
 * answers 422): `?q=<10 000 characters>` is the empty search, no work at all. The same for a `scope` that is none of the three:
 * the search is over everything.
 */
export const SearchRequest = defineRequest({
  query: r.query({ q: r.string().trim().max(100).default(''), scope: r.in(SEARCH_SCOPES).default('all') }),
});

/** `/docs/search?q=…`: a page like any other — the index lives in the DocsRepository on the server, not in the browser. */
export class SearchController extends Controller {
  static request = SearchRequest;
  readonly #docs: DocsRepository;

  constructor(docs: DocsRepository) {
    super();
    this.#docs = docs;
  }

  handle(ctx: ContextOf<typeof SearchRequest>) {
    // A function: computed only when sent — typing reloads `only: ['results']`.
    const view = this.view('docs/Search', {
      results: (): SearchResults => {
        const { q, scope } = ctx.query;
        return { q, scope, pages: scope === 'sections' ? [] : this.#docs.searchPages(q), sections: scope === 'pages' ? [] : this.#docs.search(q, { limit: 20 }) };
      },
    });
    // Only the router's layer request gets the layer. A shared link, a reload and a visit without JavaScript are the page;
    // so `base` is never rendered. Caches keep both answers apart through `Vary: x-marmeon-region` (CachePublicly).
    return regionOf(ctx.request) === 'layer' ? view.layer({ base: 'docs.home' }) : view;
  }
}

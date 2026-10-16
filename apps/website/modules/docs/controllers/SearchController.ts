import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { regionOf } from '@marmeon/http/protocol';
import { rules as r } from '@marmeon/validation';
import { DocsRepository } from '../DocsRepository.ts';

/**
 * The search's query. Longer than 100 characters is invalid — and an invalid field falls back to its default (a URL never
 * answers 422): `?q=<10 000 characters>` is the empty search, no work at all.
 */
export const SearchRequest = defineRequest({
  query: r.query({ q: r.string().trim().max(100).default('') }),
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
    const view = this.view('docs/Search', { results: () => this.#docs.search(ctx.query.q, { limit: 20 }) });
    // Only the router's layer request gets the layer. A shared link, a reload and a visit without JavaScript are the page;
    // so `base` is never rendered. Caches keep both answers apart through `Vary: x-marmeon-region` (CachePublicly).
    return regionOf(ctx.request) === 'layer' ? view.layer({ base: 'docs.home' }) : view;
  }
}

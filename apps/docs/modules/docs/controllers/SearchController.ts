import { Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import * as v from 'valibot';
import { DocsRepository } from '../DocsRepository.ts';

/**
 * The search's query (E55). Longer than 100 characters is invalid — and an invalid field falls back to its default (E56:
 * a URL never answers 422): `?q=<10 000 characters>` is the empty search, no work at all.
 */
export const SearchRequest = defineRequest({
  query: v.object({
    q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(100)), ''),
  }),
});

/** `/search?q=…`: a page like any other — the index lives in the DocsRepository on the server (E133), not in the browser. */
export class SearchController extends Controller {
  static request = SearchRequest;
  readonly #docs: DocsRepository;

  constructor(docs: DocsRepository) {
    super();
    this.#docs = docs;
  }

  handle(ctx: ContextOf<typeof SearchRequest>) {
    // A function: computed only when sent — typing reloads `only: ['results']`.
    return this.view('docs/Search', { results: () => this.#docs.search(ctx.query.q, { limit: 20 }) });
  }
}

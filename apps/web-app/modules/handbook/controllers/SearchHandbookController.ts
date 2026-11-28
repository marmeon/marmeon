import { Auth } from '@marmeon/auth';
import { pageQuery } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Search } from '@marmeon/search';
import { rules as r } from '@marmeon/validation';
import { ArticleIndex } from '../ArticleIndex.ts';
import { FaqIndex } from '../FaqIndex.ts';
import { HandbookRepository, type Audience } from '../HandbookRepository.ts';

const PER_PAGE = 10;

export const SearchHandbookRequest = defineRequest({
  query: r.query({
    q: r.string().trim().max(100).default(''),
    ...pageQuery({ perPage: PER_PAGE }),
    // A search reaches its first 1000 hits: a page past them falls back to the first, like any invalid query field.
    page: r.integer().min(1).max(1000 / PER_PAGE).default(1),
  }),
});

/**
 * `/handbook/search?q=…`: articles and questions together, ranked as one list, in the visitor's language. A guest finds what is
 * public, a member with a confirmed address also what is for members. The audience is a filter of the search, so the pages, the
 * total and the excerpts come from the documents this visitor may see — as the index holds them: on a driver that writes through
 * the queue, a change reaches them when its sync job has run.
 */
export class SearchHandbookController extends Controller {
  static request = SearchHandbookRequest;

  readonly #search: Search;
  readonly #handbook: HandbookRepository;
  readonly #auth: Auth;
  readonly #translator: Translator;

  constructor(search: Search, handbook: HandbookRepository, auth: Auth, translator: Translator) {
    super();
    this.#search = search;
    this.#handbook = handbook;
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof SearchHandbookRequest>) {
    // A member is an account with a confirmed address, as for every other members' page of the app (`verified()`): an account
    // that signed up and never confirmed is a guest here.
    const user = await this.#auth.user();
    const audiences: readonly [Audience, ...Audience[]] = user?.email_verified_at != null ? ['public', 'members'] : ['public'];
    const result = await this.#search.query({
      in: [ArticleIndex, FaqIndex],
      term: ctx.query.q,
      filters: { audience: audiences },
      locale: this.#translator.locale,
      excerpts: true,
      page: ctx.query.page,
      perPage: ctx.query.per_page,
    });
    if (!result.ok) return this.view('handbook/Search', { q: ctx.query.q, entries: [], meta: null, unavailable: true });
    return this.view('handbook/Search', {
      q: ctx.query.q,
      entries: await this.#handbook.entriesFor(result.value.data, audiences),
      meta: result.value.meta,
      unavailable: false,
    });
  }
}

import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type HttpContext, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import type { Profile } from '../ProfileDirectory.ts';

/** The query of a profile's link search: `?q=` filters the labels. An invalid value falls back to the empty search. */
export const SearchProfileLinksRequest = defineRequest({ query: r.query({ q: r.string().trim().max(60).default('') }) });

/**
 * `/users/:user/links`: the links of one profile, filtered by the URL. The route has a path parameter, and the view keeps its search in
 * the URL with `useQueryState()` — the page's own URL (`/users/<id>/links?q=…`) is what a visit goes to.
 */
export class SearchProfileLinksController extends Controller {
  static request = SearchProfileLinksRequest;

  /**
   * `user` is bound by the route (ProfileDirectory), as on the profile page; the query is parsed by the request. (`ContextOf` has
   * no room for a bound parameter, so the context is spelled out with the parsed query in place of the raw one.)
   */
  handle(ctx: Omit<HttpContext<Authenticated, { user: Profile }>, 'query'> & { readonly query: ContextOf<typeof SearchProfileLinksRequest>['query'] }) {
    const { public_id, name, links } = ctx.params.user;
    const needle = ctx.query.q.toLowerCase();
    return this.view('user-profile/Links', {
      owner: { public_id, name },
      // A function: computed only when sent (a partial reload of something else leaves it out). Only the label and the URL leave
      // the server, never the row (`user_id`).
      links: () => links.filter((link) => link.label.toLowerCase().includes(needle)).map(({ id, label, url }) => ({ id, label, url })),
    });
  }
}

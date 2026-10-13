import type { Authenticated } from '@marmeon/auth';
import { pageQuery } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Storage } from '@marmeon/storage';
import { rules as r } from '@marmeon/validation';
import { PEOPLE_SORTS, ProfileDirectory } from '../ProfileDirectory.ts';

/**
 * The query of the people list: parsed on the server, typed everywhere — `ctx.query` here, `useQueryState` and
 * `<Link query>` in the view. An invalid field falls back to its default: `/people?sort=DROP TABLE` is the list
 * by name, never a 422 — links outlive their pages.
 */
export const ListPeopleRequest = defineRequest({
  query: r.query({
    q: r.string().trim().max(60).default(''),
    sort: r.in(PEOPLE_SORTS).default('name'),
    // `?page=` and `?per_page=` (10, 25 or 50) — the page as the schema parses it: `<Pagination>` builds its links from it.
    ...pageQuery({ perPage: [10, 25, 50] }),
  }),
});

/** `/people`: everyone, filtered and sorted by the URL — ten to a page (or 25, 50), with links to the pages. */
export class ListPeopleController extends Controller {
  static request = ListPeopleRequest;
  /** An instant visit: the list's placeholder needs nothing — `<Link route="user-profile.people" instant>`. */
  declare readonly instant: {};

  readonly #directory: ProfileDirectory;
  readonly #storage: Storage;

  constructor(directory: ProfileDirectory, storage: Storage) {
    super();
    this.#directory = directory;
    this.#storage = storage;
  }

  handle(ctx: ContextOf<typeof ListPeopleRequest> & Authenticated) {
    // ctx.query: { q: string; sort: 'name' | '-name' | 'joined' | '-joined'; page: number; per_page: 10 | 25 | 50 } — parsed already.
    return this.view('user-profile/People', {
      // A function: computed only when sent (a partial reload of something else leaves it out).
      people: async () => {
        const page = await this.#directory.people(ctx.query);
        return {
          data: page.data.map((person) => ({
            publicId: person.public_id,
            name: person.name,
            avatar: person.avatar_path ? this.#storage.disk('public').url(person.avatar_path) : null,
            lastLoginAt: person.activity?.last_login_at ?? null,
            isMe: person.id === ctx.user.id,
          })),
          meta: page.meta,
        };
      },
      // The server's clock for "5 minutes ago" (SSR and hydration render the same text).
      now: new Date(),
    });
  }
}

import type { Authenticated } from '@bespokecore/auth';
import { Controller, deepMerge, defineRequest, type ContextOf } from '@bespokecore/http';
import { Storage } from '@bespokecore/storage';
import * as v from 'valibot';
import { PEOPLE_SORTS, ProfileDirectory } from '../ProfileDirectory.ts';

/**
 * The query of the people list (E55): parsed on the server, typed everywhere — `ctx.query` here, `useQueryState` and
 * `<Link query>` in the view. An invalid field falls back to its default (E56): `/people?sort=DROP TABLE` is the list
 * by name, never a 422 — links outlive their pages.
 */
export const ListPeopleRequest = defineRequest({
  query: v.object({
    q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(60)), ''),
    sort: v.optional(v.picklist(PEOPLE_SORTS), 'name'),
    cursor: v.optional(v.string()),
  }),
});

/** `/people`: everyone, filtered and sorted by the URL — ten at a time, "Load more" appends the next ten. */
export class ListPeopleController extends Controller {
  static request = ListPeopleRequest;
  /** An instant visit (E64): the list's placeholder needs nothing — `<Link route="user-profile.people" instant>`. */
  declare readonly instant: {};

  readonly #directory: ProfileDirectory;
  readonly #storage: Storage;

  constructor(directory: ProfileDirectory, storage: Storage) {
    super();
    this.#directory = directory;
    this.#storage = storage;
  }

  handle(ctx: ContextOf<typeof ListPeopleRequest> & Authenticated) {
    // ctx.query: { q: string; sort: 'name' | '-name' | 'joined' | '-joined'; cursor?: string } — parsed already.
    return this.view('user-profile/People', {
      // A partial reload with `?cursor=…` appends (`deepMerge`, matched on the id: nobody twice); a new filter or sort
      // replaces the list (`reset`, see the view). A function: computed only when sent.
      people: deepMerge(async () => {
        const page = await this.#directory.people(ctx.query);
        return {
          data: page.data.map((person) => ({
            id: person.id,
            name: person.name,
            avatar: person.avatar_path ? this.#storage.disk('public').url(person.avatar_path) : null,
            lastLoginAt: person.activity?.last_login_at ?? null,
            isMe: person.id === ctx.user.id,
          })),
          meta: page.meta,
        };
      }).matchOn('data.id'),
      // The server's clock for "5 minutes ago" (SSR and hydration render the same text).
      now: new Date(),
    });
  }
}

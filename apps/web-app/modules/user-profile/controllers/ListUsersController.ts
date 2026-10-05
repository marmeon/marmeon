import { pageQuery } from '@bespokecore/database';
import { Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import * as v from 'valibot';
import { UserRepository } from '#modules/auth';

/** The page of the API's directory: `?page=2&per_page=50` — 25, 50 or 100 a page; anything else is the default (no 422). */
export const ListUsersRequest = defineRequest({ query: v.object(pageQuery({ perPage: [25, 50, 100] })) });

/** API: the directory of people — names only, a page at a time. Needs a token that may `users:read`. */
export class ListUsersController extends Controller {
  static request = ListUsersRequest;

  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    super();
    this.#users = users;
  }

  handle(ctx: ContextOf<typeof ListUsersRequest>) {
    return this.#users.paginate(this.#users.query().select(['id', 'name']).orderBy('name').orderBy('id'), ctx.query);
  }
}

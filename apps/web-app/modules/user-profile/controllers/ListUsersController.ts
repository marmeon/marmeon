import { paginationFrom } from '@bespokecore/database';
import { Controller, type HttpContext } from '@bespokecore/http';
import { UserRepository } from '#modules/auth';

/** Public API: the directory of people — names only, a page at a time (`?page=2&per_page=50`), no session involved. */
export class ListUsersController extends Controller {
  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    super();
    this.#users = users;
  }

  handle(ctx: HttpContext) {
    return this.#users.paginate(this.#users.query().select(['id', 'name']).orderBy('name').orderBy('id'), paginationFrom(ctx.query, { perPage: 25 }));
  }
}

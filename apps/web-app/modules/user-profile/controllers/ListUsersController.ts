import { Controller } from '@bespokecore/http';
import { UserRepository } from '#modules/auth';

/** Public API: the directory of people — names only, no session involved. */
export class ListUsersController extends Controller {
  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    super();
    this.#users = users;
  }

  handle() {
    return { data: this.#users.all().map(({ id, name }) => ({ id, name })) };
  }
}

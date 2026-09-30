import { Controller } from '@bespokecore/http';
import { UserRepository } from '../UserRepository.ts';

export class ShowLoginController extends Controller {
  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    super();
    this.#users = users;
  }

  handle() {
    return this.view('auth/Login', {
      users: this.#users.all().map(({ id, name }) => ({ id, name })),
    });
  }
}

import { Controller } from '@bespokecore/http';
import { UserRepository } from '../UserRepository.ts';

export class ShowLoginController extends Controller {
  static inject = [UserRepository] as const; // generated from the constructor in step 3
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

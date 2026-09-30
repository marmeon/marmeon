import { Controller } from '@bespokecore/http';
import { AppConfig } from '../../../config/app.ts';
import { UserRepository } from '../UserRepository.ts';

export class ShowLoginController extends Controller {
  readonly #users: UserRepository;
  readonly #config: AppConfig;

  constructor(users: UserRepository, config: AppConfig) {
    super();
    this.#users = users;
    this.#config = config;
  }

  handle() {
    return this.view('auth/Login', {
      appName: this.#config.name,
      users: this.#users.all().map(({ id, name }) => ({ id, name })),
    });
  }
}

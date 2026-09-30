import { Controller } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import { AppConfig } from '../../../config/app.ts';
import { UserRepository } from '../UserRepository.ts';

export class ShowLoginController extends Controller {
  readonly #users: UserRepository;
  readonly #config: AppConfig;
  readonly #session: Session;

  constructor(users: UserRepository, config: AppConfig, session: Session) {
    super();
    this.#users = users;
    this.#config = config;
    this.#session = session;
  }

  handle() {
    return this.view('auth/Login', {
      appName: this.#config.name,
      users: this.#users.all().map(({ id, name }) => ({ id, name })),
      // Flashed by the previous request (logout, failed login) — shown once.
      status: this.#session.get('status') ?? null,
      error: this.#session.get('error') ?? null,
      // Plain HTML forms send it back as `_token` (client-side visits use the XSRF-TOKEN cookie instead).
      csrfToken: this.#session.token(),
    });
  }
}

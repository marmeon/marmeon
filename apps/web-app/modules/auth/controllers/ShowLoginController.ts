import { AuthConfig } from '@marmeon/auth';
import { Controller } from '@marmeon/http';
import { Session } from '@marmeon/session';
import { AppConfig } from '../../../config/app.ts';

export class ShowLoginController extends Controller {
  readonly #config: AppConfig;
  readonly #auth: AuthConfig;
  readonly #session: Session;

  constructor(config: AppConfig, auth: AuthConfig, session: Session) {
    super();
    this.#config = config;
    this.#auth = auth;
    this.#session = session;
  }

  handle() {
    return this.view('auth/Login', {
      appName: this.#config.name,
      // `AUTH_REMEMBER_DAYS=0` turns "Keep me signed in" off: the page then has no checkbox.
      remember: this.#auth.remember,
      // A failed sign-in without JavaScript comes back here: refill the e-mail (the password is never flashed).
      old: this.#session.old() as { email?: string },
    });
  }
}

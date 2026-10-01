import { Controller } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import { AppConfig } from '../../../config/app.ts';

export class ShowLoginController extends Controller {
  readonly #config: AppConfig;
  readonly #session: Session;

  constructor(config: AppConfig, session: Session) {
    super();
    this.#config = config;
    this.#session = session;
  }

  handle() {
    return this.view('auth/Login', {
      appName: this.#config.name,
      // A failed sign-in without JavaScript comes back here: refill the e-mail (the password is never flashed).
      old: this.#session.old() as { email?: string },
      // Plain HTML forms send it back as `_token` (client-side visits use the XSRF-TOKEN cookie instead).
      csrfToken: this.#session.token(),
    });
  }
}

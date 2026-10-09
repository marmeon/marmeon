import { AuthConfig } from '@marmeon/auth';
import { abort, Controller } from '@marmeon/http';

/**
 * After a sign-up: the same page for a new and a known address — the mail tells the rest. With
 * `AUTH_PRIVATE_REGISTRATION=false` a sign-up signs in instead and never leads here: 404, as if the route were not there.
 */
export class ShowRegistrationSentController extends Controller {
  readonly #private: boolean;

  constructor(config: AuthConfig) {
    super();
    this.#private = config.privateRegistration;
  }

  handle() {
    if (!this.#private) abort(404);
    return this.view('auth/RegistrationSent', {});
  }
}

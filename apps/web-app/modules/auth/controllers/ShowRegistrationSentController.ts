import { AuthConfig } from '@bespokecore/auth';
import { abort, Controller } from '@bespokecore/http';

/**
 * After a sign-up (E146): the same page for a new and a known address — the mail tells the rest. With
 * `AUTH_PRIVATE_REGISTRATION=false` (E193) a sign-up signs in instead and never leads here: 404, as if the route were not there.
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

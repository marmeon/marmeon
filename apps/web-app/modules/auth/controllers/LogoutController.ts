import { Auth } from '@bespokecore/auth';
import { Controller } from '@bespokecore/http';

export class LogoutController extends Controller {
  readonly #auth: Auth;

  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }

  async handle() {
    await this.#auth.logout(); // new session id, new CSRF token, nothing of the old session left
    return this.redirect().route('auth.login').with('status', 'You have been signed out.');
  }
}

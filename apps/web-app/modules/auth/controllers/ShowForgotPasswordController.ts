import { Controller } from '@bespokecore/http';
import { Session } from '@bespokecore/session';

export class ShowForgotPasswordController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle() {
    return this.view('auth/ForgotPassword', { csrfToken: this.#session.token() });
  }
}

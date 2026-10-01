import { Controller } from '@bespokecore/http';
import { Session } from '@bespokecore/session';

/** "Sudo mode": shown by confirmedPassword() before sensitive pages. */
export class ShowConfirmPasswordController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle() {
    return this.view('auth/ConfirmPassword', { csrfToken: this.#session.token() });
  }
}

import { Controller } from '@bespokecore/http';
import { Session } from '@bespokecore/session';

export class LogoutController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle() {
    this.#session.invalidate();
    return this.redirect().route('auth.login').with('status', 'You have been signed out.');
  }
}

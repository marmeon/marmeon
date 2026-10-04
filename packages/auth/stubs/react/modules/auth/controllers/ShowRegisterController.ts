import { Controller } from '@bespokecore/http';
import { Session } from '@bespokecore/session';

export class ShowRegisterController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle() {
    return this.view('auth/Register', {
      // Without JavaScript a failed submit comes back here: refill name and e-mail (passwords are never flashed).
      old: this.#session.old() as { name?: string; email?: string },
    });
  }
}

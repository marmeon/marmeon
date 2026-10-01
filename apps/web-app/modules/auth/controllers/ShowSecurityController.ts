import { Auth } from '@bespokecore/auth';
import { Controller } from '@bespokecore/http';
import { Session } from '@bespokecore/session';

/** Password and devices — behind confirmedPassword() ("sudo mode"). */
export class ShowSecurityController extends Controller {
  readonly #auth: Auth;
  readonly #session: Session;

  constructor(auth: Auth, session: Session) {
    super();
    this.#auth = auth;
    this.#session = session;
  }

  handle() {
    return this.view('auth/Security', {
      viaRemember: this.#auth.viaRemember(),
      csrfToken: this.#session.token(),
    });
  }
}

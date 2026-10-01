import { Auth, type Authenticated } from '@bespokecore/auth';
import { Controller, type HttpContext } from '@bespokecore/http';
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

  handle(ctx: HttpContext<Authenticated>) {
    return this.view('auth/Security', {
      viaRemember: this.#auth.viaRemember(),
      email: ctx.user.email,
      csrfToken: this.#session.token(),
    });
  }
}

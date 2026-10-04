import { Auth, type Authenticated } from '@bespokecore/auth';
import { Controller, type HttpContext } from '@bespokecore/http';

/** Password and devices — behind confirmedPassword() ("sudo mode"). */
export class ShowSecurityController extends Controller {
  readonly #auth: Auth;

  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }

  handle(ctx: HttpContext<Authenticated>) {
    return this.view('auth/Security', {
      viaRemember: this.#auth.viaRemember(),
      email: ctx.user.email,
    });
  }
}

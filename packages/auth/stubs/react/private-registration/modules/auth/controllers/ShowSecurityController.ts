import { Auth, type Authenticated } from '@bespokecore/auth';
import { Clock } from '@bespokecore/core';
import { Controller, type HttpContext } from '@bespokecore/http';

/** Password and devices — behind confirmedPassword() ("sudo mode"). */
export class ShowSecurityController extends Controller {
  readonly #auth: Auth;
  readonly #clock: Clock;

  constructor(auth: Auth, clock: Clock) {
    super();
    this.#auth = auth;
    this.#clock = clock;
  }

  handle(ctx: HttpContext<Authenticated>) {
    const { pending_email: pending, pending_email_expires_at: expires } = ctx.user;
    return this.view('auth/Security', {
      viaRemember: this.#auth.viaRemember(),
      email: ctx.user.email,
      // Private registration (E146): the address that waits for its link — what this user typed, free or taken alike.
      pendingEmail: pending && expires && new Date(expires).getTime() > this.#clock.now() ? pending : null,
    });
  }
}

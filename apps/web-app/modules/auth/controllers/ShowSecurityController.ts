import { Auth, AuthConfig, type Authenticated } from '@bespokecore/auth';
import { Clock } from '@bespokecore/core';
import { Controller, type HttpContext } from '@bespokecore/http';

/** Password and devices — behind confirmedPassword() ("sudo mode"). */
export class ShowSecurityController extends Controller {
  readonly #auth: Auth;
  readonly #clock: Clock;
  readonly #private: boolean;

  constructor(auth: Auth, clock: Clock, config: AuthConfig) {
    super();
    this.#auth = auth;
    this.#clock = clock;
    this.#private = config.privateRegistration;
  }

  handle(ctx: HttpContext<Authenticated>) {
    const { pending_email: pending, pending_email_expires_at: expires } = ctx.user;
    return this.view('auth/Security', {
      viaRemember: this.#auth.viaRemember(),
      email: ctx.user.email,
      // Private registration (E146, the default): a change of address waits for its link — the field shows the current address
      // again after a request. With AUTH_PRIVATE_REGISTRATION=false (E193) the new address is the account's at once.
      emailChangeWaits: this.#private,
      // The address that waits for its link — what this user typed, free or taken alike.
      pendingEmail: this.#private && pending && expires && new Date(expires).getTime() > this.#clock.now() ? pending : null,
    });
  }
}

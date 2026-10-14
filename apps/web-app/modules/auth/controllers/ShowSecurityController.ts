import { Auth, AuthConfig, SignInStore, type Authenticated } from '@marmeon/auth';
import { Clock, Container } from '@marmeon/core';
import { Controller, type HttpContext } from '@marmeon/http';

/** Password and devices — behind confirmedPassword() ("sudo mode"). */
export class ShowSecurityController extends Controller {
  readonly #auth: Auth;
  readonly #clock: Clock;
  readonly #private: boolean;
  readonly #signInsBound: boolean;

  constructor(auth: Auth, clock: Clock, config: AuthConfig, container: Container) {
    super();
    this.#auth = auth;
    this.#clock = clock;
    this.#private = config.privateRegistration;
    this.#signInsBound = container.has(SignInStore);
  }

  async handle(ctx: HttpContext<Authenticated>) {
    // Never the raw User-Agent, and no address: only the parts the page words in the user's language.
    // `null` without a bound `SignInStore`: the page leaves the section out.
    const signIns = this.#signInsBound ? (await this.#auth.signIns()).map((signIn) => ({
      id: signIn.id,
      current: signIn.current,
      remembered: signIn.remembered,
      lastSeenAt: signIn.lastSeenAt.toISOString(),
      createdAt: signIn.createdAt.toISOString(),
      device: { browser: signIn.device.browser ?? null, system: signIn.device.system ?? null },
    })) : null;
    const { pending_email: pending, pending_email_expires_at: expires } = ctx.user;
    return this.view('auth/Security', {
      signIns,
      viaRemember: this.#auth.viaRemember(),
      email: ctx.user.email,
      // Private registration (the default): a change of address waits for its link — the field shows the current address
      // again after a request. With AUTH_PRIVATE_REGISTRATION=false the new address is the account's at once.
      emailChangeWaits: this.#private,
      // The address that waits for its link — what this user typed, free or taken alike.
      pendingEmail: this.#private && pending && expires && new Date(expires).getTime() > this.#clock.now() ? pending : null,
    });
  }
}

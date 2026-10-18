import { Auth, AuthConfig, type Authenticated, EmailChange } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';

/** Password, sign-ins and devices — behind confirmedPassword() ("sudo mode"). */
export class ShowSecurityController extends Controller {
  readonly #auth: Auth;
  readonly #emailChange: EmailChange;
  readonly #private: boolean;

  constructor(auth: Auth, emailChange: EmailChange, config: AuthConfig) {
    super();
    this.#auth = auth;
    this.#emailChange = emailChange;
    this.#private = config.privateRegistration;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    // The address that waits for its link — what this user typed, free or taken alike. It lives in `email_changes`, not in `users`.
    const pending = this.#private ? await this.#emailChange.waiting() : undefined;
    return this.view('auth/Security', {
      viaRemember: this.#auth.viaRemember(),
      email: ctx.user.email,
      // Private registration (the default): a change of address waits for its link — the field shows the current address
      // again after a request. With AUTH_PRIVATE_REGISTRATION=false the new address is the account's at once.
      emailChangeWaits: this.#private,
      pendingEmail: pending?.email ?? null,
      // The browsers the account is signed in on, this one first. Only what the page shows: a name for the device, never the raw user
      // agent. No IP address is stored.
      signIns: await this.#signIns(),
    });
  }

  async #signIns() {
    return (await this.#auth.signIns()).map((signIn) => ({
      id: signIn.id,
      current: signIn.current,
      remembered: signIn.remembered,
      lastSeenAt: signIn.lastSeenAt.toISOString(),
      createdAt: signIn.createdAt.toISOString(),
      device: { browser: signIn.device.browser ?? null, system: signIn.device.system ?? null },
    }));
  }
}

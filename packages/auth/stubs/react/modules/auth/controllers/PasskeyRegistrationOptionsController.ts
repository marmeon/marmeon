import type { Authenticated } from '@marmeon/auth';
import { Passkeys } from '@marmeon/auth/passkeys';
import { Controller, type HttpContext } from '@marmeon/http';

/** The options for making a passkey (the browser's `navigator.credentials.create()`): opens the session's one challenge, for registering. */
export class PasskeyRegistrationOptionsController extends Controller {
  readonly #passkeys: Passkeys;

  constructor(passkeys: Passkeys) {
    super();
    this.#passkeys = passkeys;
  }

  async handle(_ctx: HttpContext<Authenticated>) {
    return this.json(await this.#passkeys.registrationOptions());
  }
}

import { Passkeys } from '@marmeon/auth/passkeys';
import { Controller } from '@marmeon/http';

/** The options for "Sign in with a passkey": no list of accounts, so nothing is learnt about who exists. Opens the session's one challenge. */
export class PasskeySignInOptionsController extends Controller {
  readonly #passkeys: Passkeys;

  constructor(passkeys: Passkeys) {
    super();
    this.#passkeys = passkeys;
  }

  async handle() {
    return this.json(await this.#passkeys.signInOptions());
  }
}

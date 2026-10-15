import { Passkeys } from '@marmeon/auth/passkeys';
import { Controller } from '@marmeon/http';

/** "Sudo mode": shown by confirmedPassword() before sensitive pages. Offers a passkey next to the password when the account has one that is not suspended. */
export class ShowConfirmPasswordController extends Controller {
  readonly #passkeys: Passkeys;

  constructor(passkeys: Passkeys) {
    super();
    this.#passkeys = passkeys;
  }

  async handle() {
    const passkey = (await this.#passkeys.list()).some((entry) => !entry.suspended);
    return this.view('auth/ConfirmPassword', { passkey });
  }
}

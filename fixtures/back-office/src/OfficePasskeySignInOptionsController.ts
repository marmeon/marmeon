import { Controller } from '@marmeon/http';
import { OfficePasskeys } from './guard.ts';

/** The options for "Sign in with a passkey": no list of accounts, so nothing is learnt about who exists. Opens the session's one challenge. */
export class OfficePasskeySignInOptionsController extends Controller {
  static readonly inject = [OfficePasskeys] as const;

  readonly #passkeys: OfficePasskeys;

  constructor(passkeys: OfficePasskeys) {
    super();
    this.#passkeys = passkeys;
  }

  async handle() {
    return this.json(await this.#passkeys.signInOptions());
  }
}

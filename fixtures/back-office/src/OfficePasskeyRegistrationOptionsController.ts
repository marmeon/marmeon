import { Controller } from '@marmeon/http';
import { OfficePasskeys } from './guard.ts';

/** The options for making a passkey (the browser's `navigator.credentials.create()`): opens the session's one challenge, for registering. */
export class OfficePasskeyRegistrationOptionsController extends Controller {
  static readonly inject = [OfficePasskeys] as const;

  readonly #passkeys: OfficePasskeys;

  constructor(passkeys: OfficePasskeys) {
    super();
    this.#passkeys = passkeys;
  }

  async handle() {
    return this.json(await this.#passkeys.registrationOptions());
  }
}

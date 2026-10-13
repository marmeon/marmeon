import { Passkeys } from '@marmeon/auth/passkeys';
import { Controller } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';

/** The options for proving a passkey after the password: only this account's passkeys are offered. Without a waiting sign-in there is nothing to offer. */
export class PasskeyChallengeOptionsController extends Controller {
  readonly #passkeys: Passkeys;
  readonly #translator: Translator;

  constructor(passkeys: Passkeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle() {
    const options = await this.#passkeys.challengeOptions();
    if (!options.ok) return this.json({ error: this.#translator.get('auth.two_factor.expired') }, 422);
    return this.json(options.value);
  }
}

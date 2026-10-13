import { Passkeys } from '@marmeon/auth/passkeys';
import { Controller } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';

/** The options for proving a passkey again in the signed-in session: only this account's passkeys are offered. An account without one has nothing to offer. */
export class PasskeyStepUpOptionsController extends Controller {
  readonly #passkeys: Passkeys;
  readonly #translator: Translator;

  constructor(passkeys: Passkeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle() {
    const options = await this.#passkeys.stepUpOptions();
    if (!options.ok) return this.json({ error: this.#translator.get('auth.passkeys.failed') }, 422);
    return this.json(options.value);
  }
}

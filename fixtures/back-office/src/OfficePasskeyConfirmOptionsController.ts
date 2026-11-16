import { Controller } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { OfficePasskeys } from './guard.ts';

/** The options for confirming the sudo mode with a passkey: only this editor's passkeys are offered. An editor without one has nothing to offer. */
export class OfficePasskeyConfirmOptionsController extends Controller {
  static readonly inject = [OfficePasskeys, Translator] as const;

  readonly #passkeys: OfficePasskeys;
  readonly #translator: Translator;

  constructor(passkeys: OfficePasskeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle() {
    const options = await this.#passkeys.confirmOptions();
    if (!options.ok) return this.json({ error: this.#translator.get('office.challenge.failed') }, { status: 422 });
    return this.json(options.value);
  }
}

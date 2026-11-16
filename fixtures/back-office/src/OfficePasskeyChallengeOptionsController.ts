import { Controller } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { OfficePasskeys } from './guard.ts';

/** The options for proving a passkey after the password: only this editor's passkeys are offered. Without a waiting sign-in there is nothing to offer. */
export class OfficePasskeyChallengeOptionsController extends Controller {
  static readonly inject = [OfficePasskeys, Translator] as const;

  readonly #passkeys: OfficePasskeys;
  readonly #translator: Translator;

  constructor(passkeys: OfficePasskeys, translator: Translator) {
    super();
    this.#passkeys = passkeys;
    this.#translator = translator;
  }

  async handle() {
    const options = await this.#passkeys.challengeOptions();
    if (!options.ok) return this.json({ error: this.#translator.get('office.challenge.expired') }, { status: 422 });
    return this.json(options.value);
  }
}

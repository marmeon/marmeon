import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { OfficeTwoFactor } from './guard.ts';
import { passwordMessage } from './password-message.ts';
import { CODES_LAYER } from './recovery-codes-layer.ts';

export const RegenerateRecoveryCodesRequest = defineRequest({ schema: r.object({ password: r.string().required().max(4096) }) });

/** New recovery codes in place of all the old ones, with the password typed now. The answer is a layer over the security page, shown once. */
export class RegenerateOfficeRecoveryCodesController extends Controller {
  static request = RegenerateRecoveryCodesRequest;
  static readonly inject = [OfficeTwoFactor, Translator] as const;

  readonly #twoFactor: OfficeTwoFactor;
  readonly #translator: Translator;

  constructor(twoFactor: OfficeTwoFactor, translator: Translator) {
    super();
    this.#twoFactor = twoFactor;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof RegenerateRecoveryCodesRequest>) {
    // Recovery codes belong to the editor's factors, whichever they are: without one there is nothing to make them for.
    if ((await this.#twoFactor.status()).factors.length === 0) return this.redirect().route('office.security');
    const made = await this.#twoFactor.regenerateRecoveryCodes(ctx.body.password);
    if (!made.ok) throw new ValidationError({ password: [passwordMessage(this.#translator, made.error)] });
    return this.view('office::RecoveryCodes', { codes: [...made.value], signedOut: false }).layer(CODES_LAYER);
  }
}

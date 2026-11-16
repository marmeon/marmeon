import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { OfficeTwoFactor } from './guard.ts';
import { passwordMessage } from './password-message.ts';

export const DisableTwoFactorRequest = defineRequest({ schema: r.object({ password: r.string().required().max(4096) }) });

/** Turns the authenticator off with the password typed now, however recently it was confirmed. A passkey left stays a factor. */
export class DisableOfficeTwoFactorController extends Controller {
  static request = DisableTwoFactorRequest;
  static readonly inject = [OfficeTwoFactor, Translator] as const;

  readonly #twoFactor: OfficeTwoFactor;
  readonly #translator: Translator;

  constructor(twoFactor: OfficeTwoFactor, translator: Translator) {
    super();
    this.#twoFactor = twoFactor;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof DisableTwoFactorRequest>) {
    const disabled = await this.#twoFactor.disable(ctx.body.password);
    if (!disabled.ok) throw new ValidationError({ password: [passwordMessage(this.#translator, disabled.error)] });
    return this.redirect().route('office.security');
  }
}

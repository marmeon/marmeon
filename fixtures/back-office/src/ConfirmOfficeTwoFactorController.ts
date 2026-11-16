import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { OfficeTwoFactor } from './guard.ts';
import { passwordMessage } from './password-message.ts';
import { CODES_LAYER } from './recovery-codes-layer.ts';

export const ConfirmTwoFactorRequest = defineRequest({
  // The password in the same form: turning the factor on signs the editor's other browsers out, which needs it.
  schema: r.object({ code: r.string().trim().required().max(32), password: r.string().required().max(4096) }),
});

/**
 * Turns the authenticator on with the first code it shows and the password. Every other sign-in of the editor ends. The answer holds the recovery codes,
 * a layer over the security page that answers this POST, shown once: they never sit in the session, and the database keeps only their hashes.
 */
export class ConfirmOfficeTwoFactorController extends Controller {
  static request = ConfirmTwoFactorRequest;
  static readonly inject = [OfficeTwoFactor, Translator] as const;

  readonly #twoFactor: OfficeTwoFactor;
  readonly #translator: Translator;

  constructor(twoFactor: OfficeTwoFactor, translator: Translator) {
    super();
    this.#twoFactor = twoFactor;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof ConfirmTwoFactorRequest>) {
    const done = await this.#twoFactor.confirm(ctx.body.code, ctx.body.password);
    if (!done.ok) {
      switch (done.error.kind) {
        case 'not-started':
          return this.redirect().route('office.security');
        case 'signed-out':
          // The session ended while the factor was set up: nothing was stored.
          return this.redirect().route('office.login');
        case 'throttled':
          if (done.error.account) throw new ValidationError({ password: [this.#translator.get('office.confirm.throttled', { seconds: done.error.retryAfterSeconds })] });
          throw new ValidationError({ code: [this.#translator.get('office.challenge.throttled', { seconds: done.error.retryAfterSeconds })] });
        case 'invalid-password':
          throw new ValidationError({ password: [passwordMessage(this.#translator, done.error)] });
        case 'invalid-code':
          throw new ValidationError({ code: [this.#translator.get('office.challenge.invalid')] });
      }
    }
    // A second factor beside an existing one has no new codes: the page just shows it is on.
    if (done.value.recoveryCodes === null) return this.redirect().route('office.security');
    return this.view('office::RecoveryCodes', { codes: [...done.value.recoveryCodes], signedOut: true }).layer(CODES_LAYER);
  }
}

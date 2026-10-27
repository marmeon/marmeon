import type { Authenticated } from '@marmeon/auth';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { CODES_LAYER } from '../two-factor-page.ts';

export const ConfirmTwoFactorRequest = defineRequest({
  // The password in the same form: turning the factor on signs the other devices out, which needs it.
  schema: r.object({ code: r.string().trim().required().max(32), password: r.string().required().max(4096) }),
  messages: { 'code.required': 'auth.two_factor.code_required', 'password.required': 'auth.validation.password_required' },
});

/**
 * Turns the authenticator on with the first code it shows and the password. Every other device is signed out; API tokens are not
 * touched. The answer holds the recovery codes: a layer over the settings page that
 * answers this POST, shown once — they never sit in the session, and the database keeps only their hashes.
 */
export class ConfirmTwoFactorController extends Controller {
  static request = ConfirmTwoFactorRequest;

  readonly #twoFactor: TwoFactor;
  readonly #translator: Translator;

  constructor(twoFactor: TwoFactor, translator: Translator) {
    super();
    this.#twoFactor = twoFactor;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof ConfirmTwoFactorRequest> & Authenticated) {
    const done = await this.#twoFactor.confirm(ctx.body.code, ctx.body.password);
    if (!done.ok) {
      switch (done.error.kind) {
        case 'not-started':
          return this.redirect().route('auth.two-factor');
        case 'signed-out':
          // The session ended while the factor was set up: nothing was stored.
          return this.redirect().route('auth.login');
        case 'throttled':
          if (done.error.account) throw new ValidationError({ password: [this.#translator.get('auth.validation.throttled_account', { seconds: done.error.retryAfterSeconds })] });
          throw new ValidationError({ code: [this.#translator.get('auth.two_factor.throttled', { seconds: done.error.retryAfterSeconds })] });
        case 'invalid-password':
          throw new ValidationError({ password: [this.#translator.get('auth.validation.password_incorrect')] });
        case 'invalid-code':
          throw new ValidationError({ code: [this.#translator.get('auth.two_factor.invalid')] });
      }
    }
    // A second factor beside an existing one has no new codes: the page just shows it is on.
    if (done.value.recoveryCodes === null) return this.redirect().route('auth.two-factor');
    return this.view('auth/RecoveryCodes', { codes: [...done.value.recoveryCodes], signedOut: true }).layer(CODES_LAYER);
  }
}

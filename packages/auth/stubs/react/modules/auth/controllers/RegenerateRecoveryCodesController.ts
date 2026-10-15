import type { Authenticated } from '@marmeon/auth';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { CODES_LAYER } from '../two-factor-page.ts';

export const RegenerateRecoveryCodesRequest = defineRequest({
  schema: r.object({ password: r.string().required().max(4096) }),
  messages: { 'password.required': 'auth.validation.password_required' },
});

/** New recovery codes in place of all the old ones, with the password typed now — a layer over the settings page that answers the POST, shown once. */
export class RegenerateRecoveryCodesController extends Controller {
  static request = RegenerateRecoveryCodesRequest;

  readonly #twoFactor: TwoFactor;
  readonly #translator: Translator;

  constructor(twoFactor: TwoFactor, translator: Translator) {
    super();
    this.#twoFactor = twoFactor;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof RegenerateRecoveryCodesRequest> & Authenticated) {
    // Recovery codes belong to the account's factors, whichever they are: without one there is nothing to make them for.
    if ((await this.#twoFactor.status()).factors.length === 0) return this.redirect().route('auth.two-factor');
    const made = await this.#twoFactor.regenerateRecoveryCodes(ctx.body.password);
    if (!made.ok) {
      const message = made.error.kind === 'throttled' ? (made.error.account ? this.#translator.get('auth.validation.throttled_account') : this.#translator.get('auth.validation.throttled', { seconds: made.error.retryAfter })) : this.#translator.get('auth.validation.password_incorrect');
      throw new ValidationError({ password: [message] });
    }
    return this.view('auth/RecoveryCodes', { codes: [...made.value], tokens: null }).layer(CODES_LAYER);
  }
}

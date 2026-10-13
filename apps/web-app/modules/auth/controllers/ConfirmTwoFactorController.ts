import type { Authenticated } from '@marmeon/auth';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { Controller, defineRequest, ValidationError, type ContextOf, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { CODES_LAYER } from '../two-factor-page.ts';

export const ConfirmTwoFactorRequest = defineRequest({
  schema: r.object({ code: r.string().trim().required().max(32) }),
  messages: { 'code.required': 'auth.two_factor.code_required' },
  authorize: (_ctx: HttpContext<Authenticated>) => true,
});

/**
 * Turns the authenticator on with the first code it shows. The answer holds the recovery codes: a layer over the settings page that
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

  async handle(ctx: ContextOf<typeof ConfirmTwoFactorRequest>) {
    const done = await this.#twoFactor.confirm(ctx.body.code);
    if (!done.ok) {
      switch (done.error.kind) {
        case 'not-started':
          return this.redirect().route('auth.two-factor');
        case 'throttled':
          throw new ValidationError({ code: [this.#translator.get('auth.two_factor.throttled', { seconds: done.error.retryAfter })] });
        case 'invalid-code':
          throw new ValidationError({ code: [this.#translator.get('auth.two_factor.invalid')] });
      }
    }
    // A second factor beside an existing one has no new codes: the page just shows it is on.
    if (done.value.recoveryCodes === null) return this.redirect().route('auth.two-factor');
    return this.view('auth/RecoveryCodes', { codes: [...done.value.recoveryCodes] }).layer(CODES_LAYER);
  }
}

import { TwoFactor } from '@marmeon/auth/two-factor';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';

export const TwoFactorVerifyRequest = defineRequest({
  schema: r.object({ code: r.string().trim().max(32).default(''), recovery_code: r.string().trim().max(64).default('') }),
});

/**
 * Proves the second factor in the session the user already has, and goes back to the page that asked for it (the dashboard when nothing did). The throttle lives in
 * `TwoFactor`, as for the sign-in; a wrong code does not end the session. One request per session at a time (block()).
 */
export class TwoFactorVerifyController extends Controller {
  static request = TwoFactorVerifyRequest;

  readonly #twoFactor: TwoFactor;
  readonly #translator: Translator;

  constructor(twoFactor: TwoFactor, translator: Translator) {
    super();
    this.#twoFactor = twoFactor;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof TwoFactorVerifyRequest>) {
    const { code, recovery_code: recoveryCode } = ctx.body;
    const field = recoveryCode !== '' ? 'recovery_code' : 'code';
    const done = await this.#twoFactor.stepUp(recoveryCode !== '' ? { recoveryCode } : { code });
    if (done.ok) return this.redirect().intended().route('dashboard');

    switch (done.error.kind) {
      case 'no-challenge':
      case 'expired':
        // No factor to prove (it was turned off meanwhile): the settings page is where one is set up.
        return this.redirect().route('auth.two-factor');
      case 'throttled':
        throw new ValidationError({ [field]: [this.#translator.get('auth.two_factor.throttled', { seconds: done.error.retryAfter })] });
      case 'invalid-code': {
        const what = this.#translator.get(field === 'code' ? 'auth.two_factor.invalid' : 'auth.two_factor.invalid_recovery');
        throw new ValidationError({ [field]: [done.error.attemptsLeft <= 2 ? this.#translator.get('auth.two_factor.invalid_left', { what, count: done.error.attemptsLeft }) : what] });
      }
    }
  }
}

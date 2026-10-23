import { TwoFactor } from '@marmeon/auth/two-factor';
import type { AuthenticationResponseJSON } from '@marmeon/auth/passkeys';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';

export const PasskeyStepUpRequest = defineRequest({
  schema: r.object({
    response: r.value<AuthenticationResponseJSON>((value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : 'auth.passkeys.failed')),
  }),
});

/**
 * Proves the second factor with a passkey in the session the user already has, and goes back to the page that asked for it. The throttle,
 * the event and the check against the stored passkey live in `TwoFactor` and `Passkeys`; a wrong response does not end the session.
 * One of these requests per session at a time (block()).
 */
export class PasskeyStepUpController extends Controller {
  static request = PasskeyStepUpRequest;

  readonly #twoFactor: TwoFactor;
  readonly #translator: Translator;

  constructor(twoFactor: TwoFactor, translator: Translator) {
    super();
    this.#twoFactor = twoFactor;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof PasskeyStepUpRequest>) {
    const done = await this.#twoFactor.stepUp({ passkey: ctx.body.response });
    if (done.ok) return this.redirect().intended().route('dashboard');
    switch (done.error.kind) {
      case 'no-challenge':
      case 'expired':
        // No factor to prove (it was turned off meanwhile): the settings page is where one is set up.
        return this.redirect().route('auth.two-factor');
      case 'throttled':
        return this.json({ error: this.#translator.get('auth.two_factor.throttled', { seconds: done.error.retryAfter }) }, { status: 429 });
      case 'invalid-code':
        return this.json({ error: this.#translator.get('auth.passkeys.failed') }, { status: 422 });
    }
  }
}

import { TwoFactor } from '@marmeon/auth/two-factor';
import type { AuthenticationResponseJSON } from '@marmeon/auth/passkeys';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';

export const PasskeyChallengeRequest = defineRequest({
  schema: r.object({
    response: r.value<AuthenticationResponseJSON>((value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : 'auth.passkeys.failed')),
  }),
});

/**
 * Finishes the sign-in with a passkey of the account that typed the password. The wrong-factor count, the throttle and the check against
 * the stored passkey live in `TwoFactor` and `Passkeys`; this maps their answers. One of these requests per session at a time (block()).
 */
export class PasskeyChallengeController extends Controller {
  static request = PasskeyChallengeRequest;

  readonly #twoFactor: TwoFactor;
  readonly #translator: Translator;

  constructor(twoFactor: TwoFactor, translator: Translator) {
    super();
    this.#twoFactor = twoFactor;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof PasskeyChallengeRequest>) {
    const done = await this.#twoFactor.challenge({ passkey: ctx.body.response });
    if (done.ok) return this.redirect().intended().route('dashboard');
    switch (done.error.kind) {
      case 'no-challenge':
      case 'expired':
        return this.json({ error: this.#translator.get('auth.two_factor.expired'), login: true }, 422);
      case 'throttled':
        return this.json({ error: this.#translator.get('auth.two_factor.throttled', { seconds: done.error.retryAfter }) }, 429);
      case 'invalid-code':
        // The last wrong try ended the wait: the password is typed again.
        if (done.error.attemptsLeft === 0) return this.json({ error: this.#translator.get('auth.two_factor.locked'), login: true }, 422);
        return this.json({ error: this.#translator.get('auth.passkeys.failed') }, 422);
    }
  }
}

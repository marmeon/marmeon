import { TwoFactor } from '@marmeon/auth/two-factor';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';

export const TwoFactorChallengeRequest = defineRequest({
  // A code from the authenticator app, or a recovery code — whichever the form sent. Never trimmed of anything but the edges.
  schema: r.object({ code: r.string().trim().max(32).default(''), recovery_code: r.string().trim().max(64).default('') }),
});

/**
 * Finishes the sign-in with the second factor. The throttle (per account, before the code is looked at) and the count of wrong
 * codes live in `TwoFactor`; this only maps its answers to the page. One of these requests per session at a time (block()).
 */
export class TwoFactorChallengeController extends Controller {
  static request = TwoFactorChallengeRequest;

  readonly #twoFactor: TwoFactor;
  readonly #translator: Translator;

  constructor(twoFactor: TwoFactor, translator: Translator) {
    super();
    this.#twoFactor = twoFactor;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof TwoFactorChallengeRequest>) {
    const { code, recovery_code: recoveryCode } = ctx.body;
    const field = recoveryCode !== '' ? 'recovery_code' : 'code';
    const done = await this.#twoFactor.challenge(recoveryCode !== '' ? { recoveryCode } : { code });
    if (done.ok) return this.redirect().intended().route('dashboard');

    switch (done.error.kind) {
      case 'no-challenge':
      case 'expired':
        // The password has to be typed again: the wait ended (too long, too many wrong codes, a changed password).
        return this.redirect().route('auth.login').flash('toast', { kind: 'error', message: this.#translator.get('auth.two_factor.expired') });
      case 'throttled':
        throw new ValidationError({ [field]: [this.#translator.get('auth.two_factor.throttled', { seconds: done.error.retryAfter })] });
      case 'invalid-code': {
        // The last wrong code ended the wait (Auth dropped it): the password has to be typed again.
        if (done.error.attemptsLeft === 0) return this.redirect().route('auth.login').flash('toast', { kind: 'error', message: this.#translator.get('auth.two_factor.locked') });
        const what = this.#translator.get(field === 'code' ? 'auth.two_factor.invalid' : 'auth.two_factor.invalid_recovery');
        // The tries left are said when they run low.
        const message = done.error.attemptsLeft <= 2 ? this.#translator.get('auth.two_factor.invalid_left', { what, count: done.error.attemptsLeft }) : what;
        throw new ValidationError({ [field]: [message] });
      }
    }
  }
}

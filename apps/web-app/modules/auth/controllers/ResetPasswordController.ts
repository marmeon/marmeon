import { password, PasswordBroker } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Router } from '@marmeon/router';
import { rules as r } from '@marmeon/validation';
import { clearAccountFailures } from '../account-failures.ts';
import { RESET_COOKIE, resetFromCookie } from '../reset-cookie.ts';

export const ResetPasswordRequest = defineRequest({
  schema: r.object({ password: password(), password_confirmation: r.string() }).confirmed('password'),
  messages: { 'password_confirmation.required': 'auth.validation.new_password_repeat', 'password_confirmation.confirmed': 'auth.validation.passwords_differ' },
});

export class ResetPasswordController extends Controller {
  static request = ResetPasswordRequest;

  readonly #broker: PasswordBroker;
  readonly #router: Router;
  readonly #translator: Translator;
  readonly #limiter: RateLimiter;

  constructor(broker: PasswordBroker, router: Router, translator: Translator, limiter: RateLimiter) {
    super();
    this.#broker = broker;
    this.#router = router;
    this.#translator = translator;
    this.#limiter = limiter;
  }

  async handle(ctx: ContextOf<typeof ResetPasswordRequest>) {
    const reset = resetFromCookie(ctx.cookies.get(RESET_COOKIE));
    // Unknown e-mail, wrong, used or expired token: one answer.
    if (!reset || !(await this.#broker.reset(reset.email, reset.token, ctx.body.password)).ok) throw new ValidationError({ password: [this.#translator.get('auth.reset.invalid')] });
    // The owner is back in: the account takes passwords again, if guesses had shut it.
    await clearAccountFailures(this.#limiter, reset.email);
    ctx.cookies.delete(RESET_COOKIE, { path: this.#router.url('auth.password.reset') });
    return this.redirect().route('auth.login').flash('toast', { kind: 'success', message: this.#translator.get('auth.reset.done') });
  }
}

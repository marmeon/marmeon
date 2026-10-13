import type { Authenticated } from '@marmeon/auth';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { RateLimiter } from '@marmeon/cache';
import { Controller, defineRequest, type ContextOf, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { throttlePasswordChecks } from '../throttle.ts';

export const DisableTwoFactorRequest = defineRequest({
  schema: r.object({ password: r.string().required().max(4096) }),
  messages: { 'password.required': 'auth.validation.password_required' },
  authorize: (_ctx: HttpContext<Authenticated>) => true,
});

/** Turns the authenticator off — with the password typed now, however recently it was confirmed. */
export class DisableTwoFactorController extends Controller {
  static request = DisableTwoFactorRequest;

  readonly #twoFactor: TwoFactor;
  readonly #limiter: RateLimiter;
  readonly #translator: Translator;

  constructor(twoFactor: TwoFactor, limiter: RateLimiter, translator: Translator) {
    super();
    this.#twoFactor = twoFactor;
    this.#limiter = limiter;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof DisableTwoFactorRequest>) {
    await throttlePasswordChecks(this.#limiter, this.#translator, ctx.user.id, 'password', () => this.#twoFactor.disable(ctx.body.password));
    return this.redirect().route('auth.two-factor').flash('toast', { kind: 'success', message: this.#translator.get('auth.two_factor.disabled') });
  }
}

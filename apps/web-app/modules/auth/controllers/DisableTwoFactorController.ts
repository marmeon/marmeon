import { Auth, type Authenticated } from '@marmeon/auth';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { RateLimiter } from '@marmeon/cache';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { throttlePasswordChecks } from '../throttle.ts';

export const DisableTwoFactorRequest = defineRequest({
  schema: r.object({ password: r.string().required().max(4096) }),
  messages: { 'password.required': 'auth.validation.password_required' },
});

/** Turns the authenticator off — with the password typed now, however recently it was confirmed. */
export class DisableTwoFactorController extends Controller {
  static request = DisableTwoFactorRequest;

  readonly #auth: Auth;
  readonly #twoFactor: TwoFactor;
  readonly #limiter: RateLimiter;
  readonly #translator: Translator;

  constructor(auth: Auth, twoFactor: TwoFactor, limiter: RateLimiter, translator: Translator) {
    super();
    this.#auth = auth;
    this.#twoFactor = twoFactor;
    this.#limiter = limiter;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof DisableTwoFactorRequest> & Authenticated) {
    await throttlePasswordChecks(this.#limiter, this.#translator, this.#auth, ctx.user.id, 'password', () => this.#twoFactor.disable(ctx.body.password));
    // With a passkey left, only the authenticator app went: the account is still protected.
    const stillProtected = (await this.#twoFactor.status()).factors.length > 0;
    return this.redirect().route('auth.two-factor').flash('toast', { kind: 'success', message: this.#translator.get(stillProtected ? 'auth.two_factor.authenticator_removed' : 'auth.two_factor.disabled') });
  }
}

import { Auth, type Authenticated } from '@bespokecore/auth';
import { RateLimiter } from '@bespokecore/cache';
import { Controller, defineRequest, type ContextOf, type HttpContext } from '@bespokecore/http';
import { trans, Translator } from '@bespokecore/i18n';
import * as v from 'valibot';
import { throttlePasswordChecks } from '../throttle.ts';

export const ConfirmPasswordRequest = defineRequest({
  schema: v.object({ password: v.pipe(v.string(trans('auth.validation.password_required')), v.nonEmpty(trans('auth.validation.password_required')), v.maxLength(4096)) }),
  authorize: (_ctx: HttpContext<Authenticated>) => true,
});

export class ConfirmPasswordController extends Controller {
  static request = ConfirmPasswordRequest;

  readonly #auth: Auth;
  readonly #limiter: RateLimiter;
  readonly #translator: Translator;

  constructor(auth: Auth, limiter: RateLimiter, translator: Translator) {
    super();
    this.#auth = auth;
    this.#limiter = limiter;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof ConfirmPasswordRequest>) {
    await throttlePasswordChecks(this.#limiter, this.#translator, ctx.user.id, 'password', () => this.#auth.confirmPassword(ctx.body.password));
    return this.redirect().intended().route('auth.security');
  }
}

import { Auth, type Authenticated } from '@bespokecore/auth';
import { RateLimiter } from '@bespokecore/cache';
import { Controller, defineRequest, type ContextOf, type HttpContext } from '@bespokecore/http';
import * as v from 'valibot';
import { throttlePasswordChecks } from '../throttle.ts';

export const ConfirmPasswordRequest = defineRequest({
  schema: v.object({ password: v.pipe(v.string('Enter your password.'), v.nonEmpty('Enter your password.'), v.maxLength(4096)) }),
  authorize: (_ctx: HttpContext<Authenticated>) => true,
});

export class ConfirmPasswordController extends Controller {
  static request = ConfirmPasswordRequest;

  readonly #auth: Auth;
  readonly #limiter: RateLimiter;

  constructor(auth: Auth, limiter: RateLimiter) {
    super();
    this.#auth = auth;
    this.#limiter = limiter;
  }

  async handle(ctx: ContextOf<typeof ConfirmPasswordRequest>) {
    await throttlePasswordChecks(this.#limiter, ctx.user.id, 'password', () => this.#auth.confirmPassword(ctx.body.password));
    return this.redirect().intended().route('auth.security');
  }
}

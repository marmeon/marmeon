import { Auth, confirmed, password, type Authenticated } from '@bespokecore/auth';
import { RateLimiter } from '@bespokecore/cache';
import { Controller, defineRequest, type ContextOf, type HttpContext } from '@bespokecore/http';
import * as v from 'valibot';
import { throttlePasswordChecks } from '../throttle.ts';

export const UpdatePasswordRequest = defineRequest({
  schema: confirmed(
    v.object({
      current_password: v.pipe(v.string('Enter your current password.'), v.nonEmpty('Enter your current password.'), v.maxLength(4096)),
      password: password(),
      password_confirmation: v.string('Repeat the new password.'),
    }),
  ),
  authorize: (_ctx: HttpContext<Authenticated>) => true,
});

/** A new password: every other session and every remember-me token ends; this session stays. */
export class UpdatePasswordController extends Controller {
  static request = UpdatePasswordRequest;

  readonly #auth: Auth;
  readonly #limiter: RateLimiter;

  constructor(auth: Auth, limiter: RateLimiter) {
    super();
    this.#auth = auth;
    this.#limiter = limiter;
  }

  async handle(ctx: ContextOf<typeof UpdatePasswordRequest>) {
    await throttlePasswordChecks(this.#limiter, ctx.user.id, 'current_password', () => this.#auth.confirmPassword(ctx.body.current_password));
    await this.#auth.updatePassword(ctx.body.password);
    return this.back('/settings/security').with('status', 'Password changed. You were signed out everywhere else.');
  }
}

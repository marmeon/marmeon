import { Auth, confirmed, password, type Authenticated } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import { Controller, defineRequest, type ContextOf, type HttpContext } from '@marmeon/http';
import { trans, Translator } from '@marmeon/i18n';
import * as v from 'valibot';
import { throttlePasswordChecks } from '../throttle.ts';

export const UpdatePasswordRequest = defineRequest({
  schema: confirmed(
    v.object({
      current_password: v.pipe(v.string(trans('auth.validation.current_password_required')), v.nonEmpty(trans('auth.validation.current_password_required')), v.maxLength(4096)),
      password: password(),
      password_confirmation: v.string(trans('auth.validation.new_password_repeat')),
    }),
  ),
  authorize: (_ctx: HttpContext<Authenticated>) => true,
});

/** A new password: every other session and every remember-me token ends; this session stays. */
export class UpdatePasswordController extends Controller {
  static request = UpdatePasswordRequest;

  readonly #auth: Auth;
  readonly #limiter: RateLimiter;
  readonly #translator: Translator;

  constructor(auth: Auth, limiter: RateLimiter, translator: Translator) {
    super();
    this.#auth = auth;
    this.#limiter = limiter;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof UpdatePasswordRequest>) {
    await throttlePasswordChecks(this.#limiter, this.#translator, ctx.user.id, 'current_password', () => this.#auth.confirmPassword(ctx.body.current_password));
    await this.#auth.updatePassword(ctx.body.password);
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.password_changed') });
  }
}

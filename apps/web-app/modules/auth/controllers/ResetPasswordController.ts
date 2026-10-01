import { confirmed, password, PasswordBroker } from '@bespokecore/auth';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@bespokecore/http';
import { Router } from '@bespokecore/router';
import * as v from 'valibot';
import { RESET_COOKIE, resetFromCookie } from '../reset-cookie.ts';

export const ResetPasswordRequest = defineRequest({
  schema: confirmed(v.object({ password: password(), password_confirmation: v.string('Repeat the new password.') })),
});

const INVALID = 'This password reset link is invalid or has expired. Ask for a new one.';

export class ResetPasswordController extends Controller {
  static request = ResetPasswordRequest;

  readonly #broker: PasswordBroker;
  readonly #router: Router;

  constructor(broker: PasswordBroker, router: Router) {
    super();
    this.#broker = broker;
    this.#router = router;
  }

  async handle(ctx: ContextOf<typeof ResetPasswordRequest>) {
    const reset = resetFromCookie(ctx.cookies.get(RESET_COOKIE));
    // Unknown e-mail, wrong, used or expired token: one answer.
    if (!reset || !(await this.#broker.reset(reset.email, reset.token, ctx.body.password))) throw new ValidationError({ password: [INVALID] });
    ctx.cookies.delete(RESET_COOKIE, { path: this.#router.url('auth.password.reset') });
    return this.redirect().route('auth.login').with('status', 'Your password has been reset. Sign in with the new one.');
  }
}

import { confirmed, password, PasswordBroker } from '@bespokecore/auth';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@bespokecore/http';
import { trans, Translator } from '@bespokecore/i18n';
import { Router } from '@bespokecore/router';
import * as v from 'valibot';
import { RESET_COOKIE, resetFromCookie } from '../reset-cookie.ts';

export const ResetPasswordRequest = defineRequest({
  schema: confirmed(v.object({ password: password(), password_confirmation: v.string(trans('auth.validation.new_password_repeat')) })),
});

export class ResetPasswordController extends Controller {
  static request = ResetPasswordRequest;

  readonly #broker: PasswordBroker;
  readonly #router: Router;
  readonly #translator: Translator;

  constructor(broker: PasswordBroker, router: Router, translator: Translator) {
    super();
    this.#broker = broker;
    this.#router = router;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof ResetPasswordRequest>) {
    const reset = resetFromCookie(ctx.cookies.get(RESET_COOKIE));
    // Unknown e-mail, wrong, used or expired token: one answer.
    if (!reset || !(await this.#broker.reset(reset.email, reset.token, ctx.body.password))) throw new ValidationError({ password: [this.#translator.get('auth.reset.invalid')] });
    ctx.cookies.delete(RESET_COOKIE, { path: this.#router.url('auth.password.reset') });
    return this.redirect().route('auth.login').with('status', this.#translator.get('auth.reset.done'));
  }
}

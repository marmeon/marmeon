import { password, PasswordBroker } from '@marmeon/auth';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Router } from '@marmeon/router';
import { rules as r } from '@marmeon/validation';
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

  constructor(broker: PasswordBroker, router: Router, translator: Translator) {
    super();
    this.#broker = broker;
    this.#router = router;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof ResetPasswordRequest>) {
    const reset = resetFromCookie(ctx.cookies.get(RESET_COOKIE));
    // Unknown e-mail, wrong, used or expired token: one answer.
    const done = reset && (await this.#broker.reset(reset.email, reset.token, ctx.body.password));
    if (!done?.ok) throw new ValidationError({ password: [this.#translator.get('auth.reset.invalid')] });
    // The owner proved the inbox: this browser gets a device cookie, so strangers filling the account's daily ceiling again cannot lock it out.
    const device = await this.#broker.deviceCookie(done.value);
    if (device) ctx.cookies.set(device.name, device.value, device.options);
    ctx.cookies.delete(RESET_COOKIE, { path: this.#router.url('auth.password.reset') });
    return this.redirect().route('auth.login').flash('toast', { kind: 'success', message: this.#translator.get('auth.reset.done') });
  }
}

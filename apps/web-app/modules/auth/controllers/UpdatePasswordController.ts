import { Auth, password, type Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { passwordCheckMessage } from '../password-errors.ts';

export const UpdatePasswordRequest = defineRequest({
  schema: r.object({ current_password: r.string().required().max(4096), password: password(), password_confirmation: r.string() }).confirmed('password'),
  messages: {
    'current_password.required': 'auth.validation.current_password_required',
    'password_confirmation.required': 'auth.validation.new_password_repeat',
    'password_confirmation.confirmed': 'auth.validation.passwords_differ',
  },
});

/** A new password: every other session and every remember-me token ends; this session stays. */
export class UpdatePasswordController extends Controller {
  static request = UpdatePasswordRequest;

  readonly #auth: Auth;
  readonly #translator: Translator;

  constructor(auth: Auth, translator: Translator) {
    super();
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof UpdatePasswordRequest> & Authenticated) {
    const checked = await this.#auth.checkPassword(ctx.body.current_password);
    if (!checked.ok) throw new ValidationError({ current_password: [passwordCheckMessage(this.#translator, checked.error)] });
    await this.#auth.updatePassword(ctx.body.password);
    // The new session key made the cookie of this browser worthless: it gets a new one.
    const device = await this.#auth.deviceCookie();
    if (device) ctx.cookies.set(device.name, device.value, device.options);
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.password_changed') });
  }
}

import { Auth, type Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { passwordCheckMessage } from '../password-errors.ts';

export const LogoutOtherDevicesRequest = defineRequest({
  schema: r.object({ password: r.string().required().max(4096) }),
  messages: { 'password.required': 'auth.validation.password_required' },
});

export class LogoutOtherDevicesController extends Controller {
  static request = LogoutOtherDevicesRequest;

  readonly #auth: Auth;
  readonly #translator: Translator;

  constructor(auth: Auth, translator: Translator) {
    super();
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof LogoutOtherDevicesRequest> & Authenticated) {
    const checked = await this.#auth.checkPassword(ctx.body.password);
    if (!checked.ok) throw new ValidationError({ password: [passwordCheckMessage(this.#translator, checked.error)] });
    await this.#auth.updateSessionKey();
    // The new session key made the cookie of this browser worthless: it gets a new one.
    const device = await this.#auth.deviceCookie();
    if (device) ctx.cookies.set(device.name, device.value, device.options);
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.devices_done') });
  }
}

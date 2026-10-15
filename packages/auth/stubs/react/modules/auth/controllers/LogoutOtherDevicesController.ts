import { Auth, type Authenticated } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { throttlePasswordChecks } from '../throttle.ts';

export const LogoutOtherDevicesRequest = defineRequest({
  schema: r.object({ password: r.string().required().max(4096) }),
  messages: { 'password.required': 'auth.validation.password_required' },
});

export class LogoutOtherDevicesController extends Controller {
  static request = LogoutOtherDevicesRequest;

  readonly #auth: Auth;
  readonly #limiter: RateLimiter;
  readonly #translator: Translator;

  constructor(auth: Auth, limiter: RateLimiter, translator: Translator) {
    super();
    this.#auth = auth;
    this.#limiter = limiter;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof LogoutOtherDevicesRequest> & Authenticated) {
    await throttlePasswordChecks(this.#limiter, this.#translator, this.#auth, ctx.user.id, 'password', () => this.#auth.logoutOtherDevices(ctx.body.password));
    return this.back('/settings/security').flash('toast', { kind: 'success', message: this.#translator.get('auth.security.devices_done') });
  }
}

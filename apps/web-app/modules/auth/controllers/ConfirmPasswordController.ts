import { Auth, type Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { passwordCheckMessage } from '../password-errors.ts';

export const ConfirmPasswordRequest = defineRequest({
  schema: r.object({ password: r.string().required().max(4096) }),
  messages: { 'password.required': 'auth.validation.password_required' },
});

export class ConfirmPasswordController extends Controller {
  static request = ConfirmPasswordRequest;

  readonly #auth: Auth;
  readonly #translator: Translator;

  constructor(auth: Auth, translator: Translator) {
    super();
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof ConfirmPasswordRequest> & Authenticated) {
    const checked = await this.#auth.checkPassword(ctx.body.password);
    if (!checked.ok) throw new ValidationError({ password: [passwordCheckMessage(this.#translator, checked.error)] });
    return this.redirect().intended().route('auth.security');
  }
}

import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { OfficeAuth } from './guard.ts';

export const ConfirmRequest = defineRequest({ schema: r.object({ password: r.string().required().max(4096) }) });

/** Opens the editor's sudo window with the editor's password. The app's window is another one: a customer's confirmation opens nothing here. */
export class ConfirmController extends Controller {
  static request = ConfirmRequest;
  static readonly inject = [OfficeAuth, Translator] as const;

  readonly #auth: OfficeAuth;
  readonly #translator: Translator;

  constructor(auth: OfficeAuth, translator: Translator) {
    super();
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof ConfirmRequest>) {
    const checked = await this.#auth.checkPassword(ctx.body.password);
    if (!checked.ok) {
      const message = checked.error.kind === 'invalid-password' ? this.#translator.get('office.confirm.incorrect') : this.#translator.get('office.confirm.throttled', { seconds: checked.error.retryAfterSeconds });
      throw new ValidationError({ password: [message] });
    }
    return this.redirect().intended().route('office.secure');
  }
}

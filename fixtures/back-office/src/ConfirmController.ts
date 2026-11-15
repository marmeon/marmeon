import { Controller, defineRequest, ValidationError, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Session } from '@marmeon/session';
import { rules as r } from '@marmeon/validation';
import { BackOfficeConfig } from './BackOfficeConfig.ts';
import { OfficeAuth } from './guard.ts';
import { intendedBelow } from './intended.ts';

export const ConfirmRequest = defineRequest({ schema: r.object({ password: r.string().required().max(4096) }) });

/** Opens the editor's sudo window with the editor's password. The app's window is another one: a customer's confirmation opens nothing here. */
export class ConfirmController extends Controller {
  static request = ConfirmRequest;
  static readonly inject = [OfficeAuth, Translator, Session, BackOfficeConfig] as const;

  readonly #auth: OfficeAuth;
  readonly #translator: Translator;
  readonly #session: Session;
  readonly #config: BackOfficeConfig;

  constructor(auth: OfficeAuth, translator: Translator, session: Session, config: BackOfficeConfig) {
    super();
    this.#auth = auth;
    this.#translator = translator;
    this.#session = session;
    this.#config = config;
  }

  async handle(ctx: ContextOf<typeof ConfirmRequest>) {
    const checked = await this.#auth.checkPassword(ctx.body.password);
    if (!checked.ok) {
      const message = checked.error.kind === 'invalid-password' ? this.#translator.get('office.confirm.incorrect') : this.#translator.get('office.confirm.throttled', { seconds: checked.error.retryAfterSeconds });
      throw new ValidationError({ password: [message] });
    }
    // Only a page of the back office, as at the sign-in.
    return intendedBelow(this.#session, this.#config.path) ? this.redirect().intended().route('office.secure') : this.redirect().route('office.secure');
  }
}

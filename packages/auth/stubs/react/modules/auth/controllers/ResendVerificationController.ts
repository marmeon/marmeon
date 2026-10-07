import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { VerificationMailer } from '../verification.ts';

export class ResendVerificationController extends Controller {
  readonly #mailer: VerificationMailer;
  readonly #translator: Translator;

  constructor(mailer: VerificationMailer, translator: Translator) {
    super();
    this.#mailer = mailer;
    this.#translator = translator;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    if (ctx.user.email_verified_at !== null) return this.redirect().route('dashboard');
    await this.#mailer.send(ctx.user);
    return this.back('/email/verify').flash('toast', { kind: 'success', message: this.#translator.get('auth.verify.sent') });
  }
}

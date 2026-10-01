import type { Authenticated } from '@bespokecore/auth';
import { Controller, type HttpContext } from '@bespokecore/http';
import { VerificationMailer } from '../verification.ts';

export class ResendVerificationController extends Controller {
  readonly #mailer: VerificationMailer;

  constructor(mailer: VerificationMailer) {
    super();
    this.#mailer = mailer;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    if (ctx.user.email_verified_at !== null) return this.redirect().route('dashboard');
    await this.#mailer.send(ctx.user);
    return this.back('/email/verify').with('status', 'A new verification link is on its way.');
  }
}

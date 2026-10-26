import { createHash } from 'node:crypto';
import type { Authenticated } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import { Controller, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { VerificationMailer } from '../verification.ts';

export class ResendVerificationController extends Controller {
  readonly #mailer: VerificationMailer;
  readonly #translator: Translator;
  readonly #limiter: RateLimiter;

  constructor(mailer: VerificationMailer, translator: Translator, limiter: RateLimiter) {
    super();
    this.#mailer = mailer;
    this.#translator = translator;
    this.#limiter = limiter;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    if (ctx.user.email_verified_at !== null) return this.redirect().route('user-profile.me');
    // At most five mails an hour to one address, whoever asks: the limits of the route count per user (`auth.verification`), and several
    // accounts can hold the same address as a pending one. Keyed on the hashed address; a refused request sends nothing and answers alike.
    const key = `verification-mail:${createHash('sha256').update(ctx.user.email).digest('hex')}`;
    if (await this.#limiter.attempt(key, { maxAttempts: 5, decay: 3600 })) await this.#mailer.send(ctx.user);
    return this.back('/email/verify').flash('toast', { kind: 'success', message: this.#translator.get('auth.verify.sent') });
  }
}

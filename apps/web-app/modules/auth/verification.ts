import { EmailVerification } from '@marmeon/auth';
import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import { AppConfig } from '../../config/app.ts';
import { VerifyEmailMail } from './mail/VerifyEmailMail.ts';
import type { User } from './users.ts';

/**
 * Queues the verification mail — after registration (from the queued listener), on request, after a change of address.
 * Composed here, sent by a worker (the signed link travels encrypted).
 */
export class VerificationMailer {
  readonly #verification: EmailVerification;
  readonly #mailer: Mailer;
  readonly #app: AppConfig;
  readonly #translators: Translators;

  constructor(verification: EmailVerification, mailer: Mailer, app: AppConfig, translators: Translators) {
    this.#verification = verification;
    this.#mailer = mailer;
    this.#app = app;
    this.#translators = translators;
  }

  /** In the user's language (stored with the account) — not the request's; links from APP_URL, never from a Host header. */
  async send(user: User): Promise<void> {
    const mail = new VerifyEmailMail(user, this.#verification.link(user, { base: this.#app.url }), this.#translators.for(user.locale));
    await this.#mailer.queue(mail, { queue: 'mail' });
  }
}

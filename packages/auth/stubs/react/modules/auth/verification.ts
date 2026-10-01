import { EmailVerification } from '@bespokecore/auth';
import { Mailer } from '@bespokecore/mail';
import { AppConfig } from '../../config/app.ts';
import { VerifyEmailMail } from './mail/VerifyEmailMail.ts';
import type { User } from './users.ts';

/** Sends the verification mail — after registration, on request, after a change of address. */
export class VerificationMailer {
  readonly #verification: EmailVerification;
  readonly #mailer: Mailer;
  readonly #app: AppConfig;

  constructor(verification: EmailVerification, mailer: Mailer, app: AppConfig) {
    this.#verification = verification;
    this.#mailer = mailer;
    this.#app = app;
  }

  async send(user: User): Promise<void> {
    await this.#mailer.send(new VerifyEmailMail(user, this.#verification.link(user, { base: this.#app.url })));
  }
}

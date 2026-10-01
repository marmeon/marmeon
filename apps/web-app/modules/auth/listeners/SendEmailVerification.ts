import type { Registered } from '@bespokecore/auth';
import { VerificationMailer } from '../verification.ts';

/** New accounts get the verification mail. */
export class SendEmailVerification {
  readonly #mailer: VerificationMailer;

  constructor(mailer: VerificationMailer) {
    this.#mailer = mailer;
  }

  async handle(event: Registered): Promise<void> {
    await this.#mailer.send(event.user);
  }
}

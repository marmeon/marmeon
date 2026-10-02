import type { Registered } from '@bespokecore/auth';
import { afterCommit } from '@bespokecore/database';
import { VerificationMailer } from '../verification.ts';

/** New accounts get the verification mail — once the account is committed (the registration runs in a transaction). */
export class SendEmailVerification {
  readonly #mailer: VerificationMailer;

  constructor(mailer: VerificationMailer) {
    this.#mailer = mailer;
  }

  async handle(event: Registered): Promise<void> {
    // Never for an account that is rolled back; outside a transaction it is sent at once.
    await afterCommit(() => this.#mailer.send(event.user));
  }
}

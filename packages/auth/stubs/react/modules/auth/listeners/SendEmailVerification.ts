import type { Registered } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { UserRepository } from '../UserRepository.ts';
import { VerificationMailer } from '../verification.ts';

/**
 * New accounts get the verification mail — a queued listener: the registration only queues it, as part of its
 * transaction (never for an account that is rolled back), and a worker composes the mail. An SMTP failure
 * never fails the registration: the mail retries in the queue.
 */
export class SendEmailVerification {
  /** Stable — queued jobs carry this name, never the class name. */
  static readonly listener = 'auth.send-email-verification';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #users: UserRepository;
  readonly #mailer: VerificationMailer;

  constructor(users: UserRepository, mailer: VerificationMailer) {
    this.#users = users;
    this.#mailer = mailer;
  }

  async handle(payload: EventPayload<typeof Registered>): Promise<void> {
    // The account as it is now: gone, or verified in the meantime — nothing to send.
    const user = await this.#users.find(payload.userId);
    if (!user || user.email_verified_at !== null) return;
    await this.#mailer.send(user);
  }
}

import { createHash } from 'node:crypto';
import type { EmailChanged } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import { EmailChangedMail } from '../mail/EmailChangedMail.ts';
import { UserRepository } from '../UserRepository.ts';

/**
 * An account's address changed (a confirmed link, or at once without private registration): the old address is told, so that an owner
 * who did not do it learns about it (one note an hour to an address). Not queued itself — it only queues the mail, in the language stored with the account.
 */
export class NotifyAboutEmailChange {
  readonly #users: UserRepository;
  readonly #mailer: Mailer;
  readonly #translators: Translators;
  readonly #limiter: RateLimiter;

  constructor(users: UserRepository, mailer: Mailer, translators: Translators, limiter: RateLimiter) {
    this.#users = users;
    this.#mailer = mailer;
    this.#translators = translators;
    this.#limiter = limiter;
  }

  async handle(event: EmailChanged): Promise<void> {
    if (event.previousEmail === null) return;
    const user = await this.#users.find(event.userId);
    if (!user) return;
    // At most one note an hour to an address: without private registration an account could swap between two addresses and fill an inbox.
    if (!(await this.#limiter.attempt(`email-changed-note:${createHash('sha256').update(event.previousEmail).digest('hex')}`, 1, 3600))) return;
    await this.#mailer.queue(new EmailChangedMail(user.name, event.previousEmail, event.email, this.#translators.for(user.locale)), { queue: 'mail' });
  }
}

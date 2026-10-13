import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import { TwoFactorMail, type TwoFactorNotice } from './mail/TwoFactorMail.ts';
import { UserRepository } from './UserRepository.ts';

/**
 * Queues the mail about a change of the second factor, from the queued listeners in `listeners/`. In the user's language (stored
 * with the account); an account that is gone by now gets nothing.
 */
export class TwoFactorNotices {
  readonly #users: UserRepository;
  readonly #mailer: Mailer;
  readonly #translators: Translators;

  constructor(users: UserRepository, mailer: Mailer, translators: Translators) {
    this.#users = users;
    this.#mailer = mailer;
    this.#translators = translators;
  }

  async send(userId: number | string, notice: TwoFactorNotice): Promise<void> {
    const user = await this.#users.find(userId as number);
    if (!user) return;
    await this.#mailer.queue(new TwoFactorMail(user, notice, this.#translators.for(user.locale)), { queue: 'mail' });
  }
}

import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import { SignInMail, type SignInNotice } from './mail/SignInMail.ts';
import { UserRepository } from './UserRepository.ts';

/**
 * Queues the mail about a sign-in that looks copied, from the queued listeners in `listeners/`. In the user's language (stored with
 * the account); an account that is gone by now gets nothing.
 */
export class SignInNotices {
  readonly #users: UserRepository;
  readonly #mailer: Mailer;
  readonly #translators: Translators;

  constructor(users: UserRepository, mailer: Mailer, translators: Translators) {
    this.#users = users;
    this.#mailer = mailer;
    this.#translators = translators;
  }

  async send(userId: number | string, notice: SignInNotice): Promise<void> {
    const user = await this.#users.find(userId as number);
    if (!user) return;
    await this.#mailer.queue(new SignInMail(user, notice, this.#translators.for(user.locale)), { queue: 'mail' });
  }
}

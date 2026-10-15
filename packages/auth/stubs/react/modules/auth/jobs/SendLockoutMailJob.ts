import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import type { JobPayload } from '@marmeon/queue';
import { Router } from '@marmeon/router';
import { rules as r } from '@marmeon/validation';
import { AppConfig } from '../../../config/app.ts';
import { LockoutMail } from '../mail/LockoutMail.ts';
import { UserRepository } from '../UserRepository.ts';

/**
 * The note to the owner of an account that stopped taking passwords. The request only queues this job — for an address with an
 * account and for one without alike, so the answer cannot tell them apart; here the account is looked up and the mail composed
 * in its language, with links from APP_URL. The address is a personal datum: the payload is encrypted.
 */
export class SendLockoutMailJob {
  static readonly job = 'auth.send-lockout-mail';
  /** The address signed in with, and the language of the request — for an account without a stored language. */
  static readonly schema = r.object({ email: r.string(), locale: r.string() });
  static readonly encrypted = true;

  readonly #users: UserRepository;
  readonly #mailer: Mailer;
  readonly #translators: Translators;
  readonly #router: Router;
  readonly #app: AppConfig;

  constructor(users: UserRepository, mailer: Mailer, translators: Translators, router: Router, app: AppConfig) {
    this.#users = users;
    this.#mailer = mailer;
    this.#translators = translators;
    this.#router = router;
    this.#app = app;
  }

  async handle(payload: JobPayload<typeof SendLockoutMailJob>): Promise<void> {
    const user = await this.#users.findByEmail(payload.email);
    if (!user) return; // no account: nobody to tell
    const link = (route: 'auth.login' | 'auth.password.request') => new URL(this.#router.url(route), this.#app.url).href;
    const t = this.#translators.for(user.locale ?? payload.locale);
    await this.#mailer.queue(new LockoutMail(user, link('auth.password.request'), link('auth.login'), t), { queue: 'mail' });
  }
}

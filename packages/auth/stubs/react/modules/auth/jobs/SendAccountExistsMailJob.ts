import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import type { JobPayload } from '@marmeon/queue';
import { Router } from '@marmeon/router';
import { rules as r } from '@marmeon/validation';
import { AppConfig } from '../../../config/app.ts';
import { AccountExistsMail } from '../mail/AccountExistsMail.ts';
import { UserRepository } from '../UserRepository.ts';

/**
 * Private registration: someone signed up with the address of an existing account. The request only queues this job —
 * as a new account's request queues its verification mail — so both answers take the same time; here the mail is composed in
 * the account's language, with links from APP_URL. The address is a personal datum: the payload is encrypted.
 */
export class SendAccountExistsMailJob {
  static readonly job = 'auth.send-account-exists-mail';
  /** The address signed up with, and the language of the sign-up — for an account without a stored language. */
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

  async handle(payload: JobPayload<typeof SendAccountExistsMailJob>): Promise<void> {
    const user = await this.#users.findByEmail(payload.email);
    if (!user) return; // deleted meanwhile
    const link = (route: 'auth.login' | 'auth.password.request') => new URL(this.#router.url(route), this.#app.url).href;
    const t = this.#translators.for(user.locale ?? payload.locale);
    await this.#mailer.queue(new AccountExistsMail(user, link('auth.login'), link('auth.password.request'), t), { queue: 'mail' });
  }
}

import { createHash } from 'node:crypto';
import { RateLimiter } from '@marmeon/cache';
import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import type { JobPayload } from '@marmeon/queue';
import { Router } from '@marmeon/router';
import { rules as r } from '@marmeon/validation';
import { UserRepository } from '#modules/auth';
import { AppConfig } from '../../../config/app.ts';
import { SocialAccountExistsMail } from '../mail/SocialAccountExistsMail.ts';
import { TARGETS } from '../targets.ts';

/**
 * Private registration: someone signed in at a provider with an address the provider did not verify. The request answers the same for an
 * address that has an account and for one that has none, and only queues this job; here it is decided. The owner of an account with that
 * address gets a note that nothing happened and nothing was linked; an address nobody has gets nothing. At most one mail goes to an address
 * an hour: a provider account with a stranger's address must not make the app a mail cannon. The address is a personal datum: the payload is encrypted.
 */
export class SendSocialAccountExistsMailJob {
  static readonly job = 'oauth.send-social-account-exists-mail';
  /** The address the provider reported, the provider's name as shown to people, and the language of the request — for an account without a stored language. */
  static readonly schema = r.object({ email: r.string(), provider: r.string(), locale: r.string() });
  static readonly encrypted = true;

  readonly #users: UserRepository;
  readonly #mailer: Mailer;
  readonly #translators: Translators;
  readonly #router: Router;
  readonly #app: AppConfig;
  readonly #limiter: RateLimiter;

  constructor(users: UserRepository, mailer: Mailer, translators: Translators, router: Router, app: AppConfig, limiter: RateLimiter) {
    this.#users = users;
    this.#mailer = mailer;
    this.#translators = translators;
    this.#router = router;
    this.#app = app;
    this.#limiter = limiter;
  }

  async handle(payload: JobPayload<typeof SendSocialAccountExistsMailJob>): Promise<void> {
    const user = await this.#users.findByEmail(payload.email);
    if (!user) return; // no account has the address, or it was deleted meanwhile
    // Keyed on the stored (normalized) address, hashed: no plain address in the cache. A refused attempt sends nothing and says nothing.
    const key = `social-account-exists-mail:${createHash('sha256').update(user.email).digest('hex')}`;
    if (!(await this.#limiter.attempt(key, { maxAttempts: 1, decay: 3600 }))) return;
    const login = new URL(this.#router.url(TARGETS.login), this.#app.url).href;
    const t = this.#translators.for(user.locale ?? payload.locale);
    try {
      await this.#mailer.queue(new SocialAccountExistsMail(user.email, payload.provider, login, this.#app.name, t), { queue: 'mail' });
    } catch (error) {
      await this.#limiter.clear(key); // nothing was sent: the retry of the job may still send the note
      throw error;
    }
  }
}

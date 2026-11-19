import { RateLimiter } from '@marmeon/cache';
import { Clock, Logger } from '@marmeon/core';
import { Translator, Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import { OAuth } from '@marmeon/oauth';
import type { SocialAccountLinked } from '@marmeon/oauth/accounts';
import { UserRepository } from '#modules/auth';
import { AppConfig } from '../../../config/app.ts';
import { SocialAccountLinkedMail } from '../mail/SocialAccountLinkedMail.ts';
import { LINK_MAILS_PER_DAY } from '../limits.ts';
import { SocialUsers } from '../SocialUsers.ts';


/** The longest nickname the mail quotes, in characters (code points: a cut never splits one): it is the provider's text, and the mail is not the place for a long one. */
const NICKNAME_MAX = 64;

/**
 * A provider account was connected to an account (by linking it, by signing in with it, or by registering with it): the owner is told, so that
 * an owner who did not do it learns about it. Not queued itself: it runs inside the request, so an account without a stored language gets
 * the request's. It only queues the mail.
 *
 * Every link mails. The cap is high on purpose: a low one would let whoever is behind a stolen session use it up with decoy links and then
 * link the real one unnoticed. Links started on the panel are bounded by `oauth.link` (20 starts a day). A callback completes up to ten
 * minutes after its start, so the starts of three daily windows can land inside one day of mails; the cap (`limits.ts`, four times the daily
 * starts: 80) lies above that. It exists for the links that signing in makes, which `oauth.link` does not see. A used-up cap logs a warning (user and provider, no address) and sends nothing.
 *
 * The mail goes only to an address the app has confirmed: it quotes the provider account, and the address of an account whose owner nobody
 * has checked may belong to a stranger. It quotes the address the provider reported, else the nickname (cut short).
 *
 * The event comes after the link is stored, so a mail that cannot be queued cannot undo it. The failure is logged first, naming the user,
 * the provider and the kind of error and no address (an error message can quote one); then the day's counter is forgotten (which errs
 * toward more mails, never fewer), and the error is thrown.
 */
export class NotifyAboutSocialAccountLinked {
  readonly #users: UserRepository;
  readonly #socialUsers: SocialUsers;
  readonly #mailer: Mailer;
  readonly #translators: Translators;
  readonly #translator: Translator;
  readonly #oauth: OAuth;
  readonly #app: AppConfig;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #limiter: RateLimiter;

  constructor(users: UserRepository, socialUsers: SocialUsers, mailer: Mailer, translators: Translators, translator: Translator, oauth: OAuth, app: AppConfig, clock: Clock, logger: Logger, limiter: RateLimiter) {
    this.#users = users;
    this.#socialUsers = socialUsers;
    this.#mailer = mailer;
    this.#translators = translators;
    this.#translator = translator;
    this.#oauth = oauth;
    this.#app = app;
    this.#clock = clock;
    this.#logger = logger;
    this.#limiter = limiter;
  }

  async handle(event: SocialAccountLinked): Promise<void> {
    const user = await this.#users.find(event.user.id as number);
    // `emailConfirmed()` may answer a promise; only an exact `true` counts, as in the package.
    if (!user || (await this.#socialUsers.emailConfirmed(user)) !== true) return;
    const key = `social-account-linked-mail:${user.id}`;
    if (!(await this.#limiter.attempt(key, { maxAttempts: LINK_MAILS_PER_DAY, decay: 86_400 }))) {
      this.#logger.warn('The mail about a linked provider account was not sent: the account reached its mails of the day', { user: user.id, provider: event.provider });
      return;
    }
    const label = this.#oauth.providers().find((provider) => provider.name === event.provider)?.label ?? event.provider;
    const address = event.email?.trim() ?? '';
    const nickname = Array.from(event.nickname?.trim() ?? '').slice(0, NICKNAME_MAX).join('');
    const account = address !== '' ? address : nickname !== '' ? nickname : null;
    const t = this.#translators.for(user.locale ?? this.#translator.locale);
    try {
      await this.#mailer.queue(new SocialAccountLinkedMail(user.email, label, account, new Date(this.#clock.now()), this.#app.name, t), { queue: 'mail' });
    } catch (error) {
      this.#logger.error('The mail about a linked provider account could not be queued: the account is linked, and its owner was not told', { user: user.id, provider: event.provider, error: error instanceof Error ? error.name : typeof error });
      // Nothing was sent. Forgets the whole day's counter, not one slot: it errs toward more mails, never fewer. A failing cache must not swallow the line above.
      await this.#limiter.clear(key).catch(() => {});
      throw error;
    }
  }
}

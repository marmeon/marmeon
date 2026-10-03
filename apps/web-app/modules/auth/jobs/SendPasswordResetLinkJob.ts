import { AuthConfig, PasswordBroker } from '@bespokecore/auth';
import { Translators } from '@bespokecore/i18n';
import { Mailer } from '@bespokecore/mail';
import type { JobPayload } from '@bespokecore/queue';
import { Router } from '@bespokecore/router';
import * as v from 'valibot';
import { AppConfig } from '../../../config/app.ts';
import { ResetPasswordMail } from '../mail/ResetPasswordMail.ts';

/**
 * The "forgot password" link, made outside the request: the request only queues this job — known address or not, the
 * answer is the same in content and in time. Here the token is created (for an account that exists) and the mail
 * composed in the account's language, with a link from APP_URL; the mail itself is queued once more (`bespoke.mail`) —
 * so an SMTP failure retries the mail with *this* token, and never asks the broker for a second one (it would refuse
 * within AUTH_RESET_THROTTLE, and the mail would be lost). The address is a personal datum: the payload is encrypted;
 * the token never is in plain text anywhere in the queue (E105).
 */
export class SendPasswordResetLinkJob {
  static readonly job = 'auth.send-password-reset-link';
  /** The address asked for, and the language it was asked in — for an account without a stored language. */
  static readonly schema = v.object({ email: v.string(), locale: v.string() });
  static readonly encrypted = true;

  readonly #broker: PasswordBroker;
  readonly #mailer: Mailer;
  readonly #translators: Translators;
  readonly #router: Router;
  readonly #app: AppConfig;
  readonly #auth: AuthConfig;

  constructor(broker: PasswordBroker, mailer: Mailer, translators: Translators, router: Router, app: AppConfig, auth: AuthConfig) {
    this.#broker = broker;
    this.#mailer = mailer;
    this.#translators = translators;
    this.#router = router;
    this.#app = app;
    this.#auth = auth;
  }

  async handle(payload: JobPayload<typeof SendPasswordResetLinkJob>): Promise<void> {
    const reset = await this.#broker.createToken(payload.email);
    if (!reset) return; // no account, or a link went out moments ago
    // The token rides in the query (the request log shows paths only); the link page moves it into a cookie.
    const url = new URL(this.#router.url('auth.password.reset', {}, { token: reset.token, email: payload.email }), this.#app.url);
    // In the account's language (whoever asked for the link, and in whatever language): the recipient's — for an account
    // without one, the language the link was asked for in.
    const t = this.#translators.for(reset.user.locale ?? payload.locale);
    await this.#mailer.queue(new ResetPasswordMail(reset.user, url.href, this.#auth.resetExpire, t), { queue: 'mail' });
  }
}

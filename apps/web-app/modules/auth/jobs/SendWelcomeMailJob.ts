import { Translators } from '@bespokecore/i18n';
import { Mailer } from '@bespokecore/mail';
import type { JobContext, JobPayload } from '@bespokecore/queue';
import * as v from 'valibot';
import { AppConfig } from '../../../config/app.ts';
import { WelcomeMail } from '../mail/WelcomeMail.ts';
import { UserRepository } from '../UserRepository.ts';

/**
 * The welcome mail after a registration — the app's first queued job (W6 step 3; `job.once` since step 4). Like a controller: one class,
 * `handle()`, constructor injection (built per attempt, in its own scope). The payload holds the user's id, never the
 * user: the job reads the account as it is when it runs.
 */
export class SendWelcomeMailJob {
  /** Stable — the queue stores this name, never the class name. */
  static readonly job = 'auth.send-welcome-mail';
  static readonly schema = v.object({ userId: v.number() });
  static readonly tries = 5;
  /** Seconds before the 2nd, 3rd, … attempt (the last repeats) — an SMTP server that is down for a while. */
  static readonly backoff = [10, 60, 300];
  static readonly timeout = 30;

  readonly #users: UserRepository;
  readonly #mailer: Mailer;
  readonly #translators: Translators;
  readonly #app: AppConfig;

  constructor(users: UserRepository, mailer: Mailer, translators: Translators, app: AppConfig) {
    this.#users = users;
    this.#mailer = mailer;
    this.#translators = translators;
    this.#app = app;
  }

  async handle(payload: JobPayload<typeof SendWelcomeMailJob>, job: JobContext): Promise<void> {
    const user = await this.#users.find(payload.userId);
    if (!user) return job.discard('the account no longer exists');
    // No request here: links from APP_URL, the language the account was made in. Once per account (E85): a retry after
    // the mail went out — the SMTP server answered slowly, the attempt timed out — does not send it again. (A worker
    // that dies between the mail and the marker still would: at-least-once, see JobContext.once.)
    await job.once(`welcome-mail:${user.id}`, () =>
      this.#mailer.send(new WelcomeMail(user, new URL('/users/me', this.#app.url).href, this.#translators.for(user.locale))),
    );
  }
}

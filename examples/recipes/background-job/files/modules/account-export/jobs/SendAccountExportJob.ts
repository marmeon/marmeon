import { Mailer } from '@marmeon/mail';
import type { JobContext, JobPayload } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { UserRepository } from '#modules/auth';
import { AccountExportMail } from '../mail/AccountExportMail.ts';

/** Mails a user the data of their account. The payload holds the user's id; the job reads the account as it is when it runs. */
export class SendAccountExportJob {
  /** Stable — the queue stores this name, never the class name. */
  static readonly job = 'account-export.send-account-export';
  static readonly schema = r.object({ userId: r.integer() });
  // Five attempts in all. A mail server that is down for a while gets the next attempt after 10 s, 1 min, then 5 min each.
  static readonly tries = 5;
  static readonly backoff = [10, 60, 300];
  static readonly timeout = 30;

  readonly #users: UserRepository;
  readonly #mailer: Mailer;

  constructor(users: UserRepository, mailer: Mailer) {
    this.#users = users;
    this.#mailer = mailer;
  }

  async handle(payload: JobPayload<typeof SendAccountExportJob>, job: JobContext): Promise<void> {
    const user = await this.#users.find(payload.userId);
    // The request checked that the address is confirmed; the job checks it again, since the account may have changed since:
    // a new address is unconfirmed until its owner confirms it. No mail, and no retry that could never succeed.
    if (!user || user.email_verified_at == null) return job.discard('the account is gone or its address is not confirmed');
    // job.id stays the same over every attempt and every retry: a record that comes back after the mail went out sends nothing more.
    await job.once(`account-export:${job.id}`, () => this.#mailer.send(new AccountExportMail(user)));
  }
}

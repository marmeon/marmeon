import type { SignInLockedOut } from '@marmeon/auth';
import { Translator } from '@marmeon/i18n';
import { Queue } from '@marmeon/queue';
import { SendLockoutMailJob } from '../jobs/SendLockoutMailJob.ts';

/**
 * An account that takes no more password sign-ins for the day: its owner is told once per window, by a worker. The job is queued for an
 * address with an account and for one without alike, so the answer to the sign-in cannot tell them apart; the job finds out. Not queued
 * itself — the language of the request is wanted — so it only queues the mail.
 */
export class QueueLockoutMail {
  readonly #queue: Queue;
  readonly #translator: Translator;

  constructor(queue: Queue, translator: Translator) {
    this.#queue = queue;
    this.#translator = translator;
  }

  async handle(event: SignInLockedOut): Promise<void> {
    if (event.scope !== 'account') return; // the minute of one client is no reason to write to the owner
    await this.#queue.dispatch(SendLockoutMailJob, { email: event.identifier, locale: this.#translator.locale }, { queue: 'mail' });
  }
}

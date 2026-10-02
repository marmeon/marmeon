import type { Registered } from '@bespokecore/auth';
import { Queue } from '@bespokecore/queue';
import { SendWelcomeMailJob } from '../jobs/SendWelcomeMailJob.ts';

/** New accounts get a welcome mail — sent by a worker, not in the registration's request. */
export class QueueWelcomeMail {
  readonly #queue: Queue;

  constructor(queue: Queue) {
    this.#queue = queue;
  }

  async handle(event: Registered): Promise<void> {
    // The default queue: the one `bespoke dev`'s worker (and a plain `bespoke queue:work`) takes.
    await this.#queue.dispatch(SendWelcomeMailJob, { userId: event.user.id });
  }
}

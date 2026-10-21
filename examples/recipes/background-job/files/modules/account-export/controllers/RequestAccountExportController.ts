import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Queue } from '@marmeon/queue';
import { SendAccountExportJob } from '../jobs/SendAccountExportJob.ts';

/** Queues the mail with the signed-in user's data; a worker sends it. */
export class RequestAccountExportController extends Controller {
  readonly #queue: Queue;

  constructor(queue: Queue) {
    super();
    this.#queue = queue;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    // The id of the signed-in user and nothing else goes into the queue. While one job of this user waits, a click queues no second one.
    await this.#queue.dispatch(SendAccountExportJob, { userId: ctx.user.id }, { unique: `account-export:${ctx.user.id}` });
    return this.redirect().route('account-export.show').flash('toast', { kind: 'success', message: 'We are sending your account data to your address.' });
  }
}

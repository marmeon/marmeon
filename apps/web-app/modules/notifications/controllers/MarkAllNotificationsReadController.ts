import type { Authenticated } from '@bespokecore/auth';
import { Controller, type HttpContext } from '@bespokecore/http';
import { Inbox } from '@bespokecore/notifications';

/** Marks all of the user's notifications read — an action (`useAction('notifications.read-all')`). */
export class MarkAllNotificationsReadController extends Controller {
  readonly #inbox: Inbox;

  constructor(inbox: Inbox) {
    super();
    this.#inbox = inbox;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    return this.json({ read: await this.#inbox.markAllRead({ type: 'user', id: ctx.user.id }) });
  }
}

import type { Authenticated } from '@marmeon/auth';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Broadcaster, notificationsChannel } from '@marmeon/live';
import { Inbox } from '@marmeon/notifications';

/** Deletes one of the user's notifications — an action (`useAction('notifications.destroy')`), optimistic in the list. */
export class DeleteNotificationController extends Controller {
  readonly #inbox: Inbox;
  readonly #broadcast: Broadcaster;

  constructor(inbox: Inbox, broadcast: Broadcaster) {
    super();
    this.#inbox = inbox;
    this.#broadcast = broadcast;
  }

  async handle(ctx: HttpContext<Authenticated, { notification: string }>) {
    // Only the user's own: someone else's id is a 404, like one that does not exist — and nothing is deleted.
    if (!(await this.#inbox.delete({ type: 'user', id: ctx.user.id }, ctx.params.notification))) abort(404);
    // The user's other tabs: their list and bell reload — and the row is gone there too (a live reload replaces the list).
    await this.#broadcast.refresh(notificationsChannel({ type: 'user', id: ctx.user.id }));
    return this.json({ deleted: ctx.params.notification });
  }
}

import type { Authenticated } from '@bespokecore/auth';
import { abort, Controller, type HttpContext } from '@bespokecore/http';
import { Broadcaster, notificationsChannel } from '@bespokecore/live';
import { Inbox } from '@bespokecore/notifications';

/** Marks one of the user's notifications read — an action (`useAction('notifications.read')`), optimistic in the list. */
export class MarkNotificationReadController extends Controller {
  readonly #inbox: Inbox;
  readonly #broadcast: Broadcaster;

  constructor(inbox: Inbox, broadcast: Broadcaster) {
    super();
    this.#inbox = inbox;
    this.#broadcast = broadcast;
  }

  async handle(ctx: HttpContext<Authenticated, { notification: string }>) {
    // Only the user's own: someone else's id is a 404, like one that does not exist — and nothing changes (the Inbox
    // looks the notification up within its recipient).
    if (!(await this.#inbox.markRead({ type: 'user', id: ctx.user.id }, ctx.params.notification))) abort(404);
    // The user's other tabs (W6.10): their bell and list reload — this tab reloads its own already (its action's reload).
    await this.#broadcast.refresh(notificationsChannel({ type: 'user', id: ctx.user.id }));
    return this.json({ read: ctx.params.notification });
  }
}

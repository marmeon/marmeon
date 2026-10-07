import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Broadcaster, notificationsChannel } from '@marmeon/live';
import { Inbox } from '@marmeon/notifications';

/** Marks all of the user's notifications read — an action (`useAction('notifications.read-all')`). */
export class MarkAllNotificationsReadController extends Controller {
  readonly #inbox: Inbox;
  readonly #broadcast: Broadcaster;

  constructor(inbox: Inbox, broadcast: Broadcaster) {
    super();
    this.#inbox = inbox;
    this.#broadcast = broadcast;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const read = await this.#inbox.markAllRead({ type: 'user', id: ctx.user.id });
    // The user's other tabs (W6.10) — not this one (x-marmeon-connection): its action reloads the bell and the list itself.
    if (read > 0) await this.#broadcast.refresh(notificationsChannel({ type: 'user', id: ctx.user.id }));
    return this.json({ read });
  }
}

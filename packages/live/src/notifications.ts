import type { Delivery, NotificationChannel } from '@bespokecore/notifications';
import type { Broadcaster } from './broadcaster.ts';

declare module '@bespokecore/notifications' {
  interface NotificationChannelMap {
    /**
     * A hint on the recipient's notifications channel (W6.10): `notificationsChannel(recipient)` — the bell and the list of a
     * page that follows it reload (no polling). Needs no method of the notification: it says only that something arrived.
     */
    live: {};
  }
}

/** The channel of a recipient's notifications: `notifications.user.7` — what the `live` channel refreshes, and the bell follows. */
export function notificationsChannel(recipient: { readonly type: string; readonly id: string | number }): string {
  return `notifications.${recipient.type}.${recipient.id}`;
}

/**
 * The notifications' `live` channel (W6.10, E92): refreshes the recipient's notifications channel — after the delivery's
 * transaction committed (its `database` row first: a page that reloads finds it). A hint without `only`: each follower
 * reloads what it follows the channel for (`only: ['bell']` in the layout, `['notifications']` on the list).
 */
export class LiveChannel implements NotificationChannel {
  readonly #broadcast: Broadcaster;

  constructor(broadcast: Broadcaster) {
    this.#broadcast = broadcast;
  }

  async deliver(delivery: Delivery): Promise<void> {
    await this.#broadcast.refresh(notificationsChannel(delivery.recipient as { type: string; id: string | number }));
  }
}

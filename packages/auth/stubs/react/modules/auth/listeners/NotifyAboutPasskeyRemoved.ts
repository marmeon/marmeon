import type { PasskeyRemoved } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { PasskeyNotices } from '../passkey-notices.ts';

/** Removing a passkey tells the owner. A queued listener. */
export class NotifyAboutPasskeyRemoved {
  /** Stable — queued jobs carry this name, never the class name. */
  static readonly listener = 'auth.notify-about-passkey-removed';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #notices: PasskeyNotices;

  constructor(notices: PasskeyNotices) {
    this.#notices = notices;
  }

  async handle(payload: EventPayload<typeof PasskeyRemoved>): Promise<void> {
    // A reset of an unconfirmed account removed it, and `NotifyAboutTwoFactorDisabled` already tells the owner once.
    if (payload.via === 'reset') return;
    await this.#notices.send(payload.userId, { kind: 'removed' });
  }
}

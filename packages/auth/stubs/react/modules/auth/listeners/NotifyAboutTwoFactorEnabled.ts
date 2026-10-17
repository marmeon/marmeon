import type { TwoFactorEnabled } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { TwoFactorNotices } from '../two-factor-notices.ts';

/** Turning a second factor on tells the owner — if it was not them, they know their account was entered. A queued listener. */
export class NotifyAboutTwoFactorEnabled {
  /** Stable — queued jobs carry this name, never the class name. */
  static readonly listener = 'auth.notify-about-two-factor-enabled';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #notices: TwoFactorNotices;

  constructor(notices: TwoFactorNotices) {
    this.#notices = notices;
  }

  async handle(payload: EventPayload<typeof TwoFactorEnabled>): Promise<void> {
    await this.#notices.send(payload.userId, { kind: 'enabled' });
  }
}

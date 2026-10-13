import type { TwoFactorEnabled } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { TwoFactorNotices } from '../two-factor-notices.ts';

/** Turning a second factor on tells the owner — if it was not them, they know their account was entered. A queued listener. */
export class NotifyAboutTwoFactorEnabled {
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #notices: TwoFactorNotices;

  constructor(notices: TwoFactorNotices) {
    this.#notices = notices;
  }

  async handle(payload: EventPayload<typeof TwoFactorEnabled>): Promise<void> {
    await this.#notices.send(payload.userId, { kind: 'enabled' });
  }
}

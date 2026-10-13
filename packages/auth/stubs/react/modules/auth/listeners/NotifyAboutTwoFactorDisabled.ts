import type { TwoFactorDisabled } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { TwoFactorNotices } from '../two-factor-notices.ts';

/** Turning the second factor off — by the user or by an operator's reset — tells the owner. A queued listener. */
export class NotifyAboutTwoFactorDisabled {
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #notices: TwoFactorNotices;

  constructor(notices: TwoFactorNotices) {
    this.#notices = notices;
  }

  async handle(payload: EventPayload<typeof TwoFactorDisabled>): Promise<void> {
    await this.#notices.send(payload.userId, { kind: payload.via === 'operator' ? 'disabled_by_operator' : 'disabled' });
  }
}

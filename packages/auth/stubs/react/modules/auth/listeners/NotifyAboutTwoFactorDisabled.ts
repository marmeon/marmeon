import type { TwoFactorDisabled } from '@marmeon/auth';
import { PasskeyStore } from '@marmeon/auth/passkeys';
import type { EventPayload } from '@marmeon/core';
import { TwoFactorNotices } from '../two-factor-notices.ts';

/** Turning the second factor off — by the user or by an operator's reset — tells the owner; with passkeys left, that only the authenticator app went. A queued listener. */
export class NotifyAboutTwoFactorDisabled {
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #notices: TwoFactorNotices;
  readonly #passkeys: PasskeyStore;

  constructor(notices: TwoFactorNotices, passkeys: PasskeyStore) {
    this.#notices = notices;
    this.#passkeys = passkeys;
  }

  async handle(payload: EventPayload<typeof TwoFactorDisabled>): Promise<void> {
    if (payload.via === 'reset') return void (await this.#notices.send(payload.userId, { kind: 'disabled_by_reset' }));
    if (payload.via === 'operator') return void (await this.#notices.send(payload.userId, { kind: 'disabled_by_operator' }));
    // The event does not say what is left: with a passkey, only the authenticator app went and the account is still protected.
    const passkeys = await this.#passkeys.forUser(payload.userId);
    await this.#notices.send(payload.userId, { kind: passkeys.length > 0 ? 'authenticator_removed' : 'disabled' });
  }
}

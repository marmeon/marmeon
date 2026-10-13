import type { PasskeyCloneSuspected } from '@marmeon/auth';
import { PasskeyStore } from '@marmeon/auth/passkeys';
import type { EventPayload } from '@marmeon/core';
import { PasskeyNotices } from '../passkey-notices.ts';

/**
 * A passkey whose sign count went backwards may have been copied: it is suspended, and the owner is told which one and how to
 * release it. A queued listener.
 */
export class NotifyAboutPasskeyCloneSuspected {
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #notices: PasskeyNotices;
  readonly #passkeys: PasskeyStore;

  constructor(notices: PasskeyNotices, passkeys: PasskeyStore) {
    this.#notices = notices;
    this.#passkeys = passkeys;
  }

  async handle(payload: EventPayload<typeof PasskeyCloneSuspected>): Promise<void> {
    const passkey = (await this.#passkeys.forUser(payload.userId)).find((record) => record.id === payload.passkeyId);
    await this.#notices.send(payload.userId, { kind: 'suspended', name: passkey?.name ?? null });
  }
}

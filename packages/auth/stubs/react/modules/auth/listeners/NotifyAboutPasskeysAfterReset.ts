import type { PasswordReset } from '@marmeon/auth';
import { PasskeyStore } from '@marmeon/auth/passkeys';
import { Logger } from '@marmeon/core';
import { PasskeyNotices } from '../passkey-notices.ts';

/**
 * A password reset ends every session, but passkeys outlive it: they still sign in without a password. Whoever reset it (the owner,
 * or somebody in their inbox) is told which passkeys the account has, so the owner can remove the ones they do not know. Nothing is
 * sent for an account without passkeys. Not queued — `PasswordReset` is not a queueable event — so it only queues the mail, and a
 * failure to do so never undoes the reset that already happened.
 */
export class NotifyAboutPasskeysAfterReset {
  readonly #notices: PasskeyNotices;
  readonly #passkeys: PasskeyStore;
  readonly #logger: Logger;

  constructor(notices: PasskeyNotices, passkeys: PasskeyStore, logger: Logger) {
    this.#notices = notices;
    this.#passkeys = passkeys;
    this.#logger = logger;
  }

  async handle(event: PasswordReset): Promise<void> {
    const userId = event.user.id;
    try {
      const names = (await this.#passkeys.forUser(userId)).map((passkey) => passkey.name);
      if (names.length > 0) await this.#notices.send(userId, { kind: 'after_reset', names });
    } catch (error) {
      this.#logger.warn('The mail about the passkeys after a password reset could not be queued.', { userId, error: String(error) });
    }
  }
}

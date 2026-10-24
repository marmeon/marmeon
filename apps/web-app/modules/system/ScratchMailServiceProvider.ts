import { randomUUID } from 'node:crypto';
import type { MailDriverFactory } from '@marmeon/mail';

/** Keeps no mail and gives each one a message id, as a provider's API would. */
const scratch: MailDriverFactory = () => ({
  send: async () => ({ messageId: `<${randomUUID()}@scratch.test>` }),
});

/** A mail transport of the app's own, `MAIL_DRIVER=scratch` — a package brings its transports the same way (docs/drivers.md#mail-transports). */
export class ScratchMailServiceProvider {
  static mailDrivers = { scratch };
}

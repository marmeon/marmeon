import { Logger } from '@marmeon/core';
import type { MailSent } from '@marmeon/mail';

/**
 * A mail was handed to its transport: one line on the `mail` channel with the mailable and the provider's message id — what
 * you look up at the provider when a mail does not arrive. Neither addresses nor subject, which can name a person.
 */
export class LogSentMail {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger.child({ channel: 'mail' });
  }

  handle(event: MailSent): void {
    this.#logger.info(`Mail sent: ${event.mailable} (${event.messageId ?? 'no id'})`);
  }
}

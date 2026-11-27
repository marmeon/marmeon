import type { EventDispatcher, Logger, Redactor } from '@marmeon/core';
import type { MailMessage } from './message.ts';

/**
 * A transport took a mail, sent at once or by the worker of a queued one; the event holds metadata only, never the content.
 * Its listeners are built from the root container on both paths, so they cannot inject scoped services.
 * See `docs/mail.md#knowing-when-a-mail-went-out`.
 */
export class MailSent {
  readonly #event = true;
  /** The mailable's class name: a label for logs, not for branching — a bundler may rename classes. */
  readonly mailable: string;
  /** The `MAIL_DRIVER` that took the mail. */
  readonly driver: string;
  /** The provider's message id; `undefined` when the transport has none. */
  readonly messageId: string | undefined;
  /** The addresses only, no display names. */
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  /** True when a worker sent the mail (`mailer.queue()`), false for `mailer.send()`. */
  readonly queued: boolean;

  constructor(data: {
    mailable: string;
    driver: string;
    messageId?: string | undefined;
    to: readonly string[];
    cc?: readonly string[];
    bcc?: readonly string[];
    subject: string;
    queued: boolean;
  }) {
    this.mailable = data.mailable;
    this.driver = data.driver;
    this.messageId = data.messageId;
    this.to = Object.freeze([...data.to]);
    this.cc = Object.freeze([...(data.cc ?? [])]);
    this.bcc = Object.freeze([...(data.bcc ?? [])]);
    this.subject = data.subject;
    this.queued = data.queued;
  }
}

/** @internal What the mailer and the job tell the reporter about a mail the transport took. */
export interface SentReport {
  readonly mailable: string;
  readonly message: MailMessage;
  readonly messageId: string | undefined;
  readonly queued: boolean;
}

/** @internal Dispatches `MailSent` and never throws. */
export type MailSentReporter = (report: SentReport) => Promise<void>;

/** @internal A transport that resolves with nothing, or with a non-string id, has no id. */
export function messageIdOf(receipt: unknown): string | undefined {
  const id = (receipt as { messageId?: unknown } | undefined)?.messageId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * @internal After delivery nothing may throw: a retry would send the mail twice. A listener's error (or a missing dispatcher)
 * is logged — redacted, and without the mail — and changes nothing about the send.
 */
export function mailSentReporter(driver: string, dispatcher: () => EventDispatcher, logger: () => Logger, redactor: () => Redactor): MailSentReporter {
  return async ({ mailable, message, messageId, queued }) => {
    try {
      await dispatcher().dispatch(
        new MailSent({
          mailable,
          driver,
          messageId,
          to: message.to.map((entry) => entry.address),
          cc: message.cc.map((entry) => entry.address),
          bcc: message.bcc.map((entry) => entry.address),
          subject: message.subject,
          queued,
        }),
      );
    } catch (error) {
      try {
        logger().warn(`A listener of MailSent failed: ${redactor().text(error instanceof Error ? error.message : String(error))}`);
      } catch {
        // Nothing may throw after the delivery, not even the log.
      }
    }
  };
}

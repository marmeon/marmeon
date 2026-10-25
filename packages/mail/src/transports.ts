import { Logger, token, type Resolver } from '@marmeon/core';
import type { MailMessage } from './message.ts';

/** What a transport reports about a delivery. */
export interface MailReceipt {
  /** The message id the provider gave the mail; `undefined` when it gave none (or no provider took part, as in `log` and `array`). */
  readonly messageId: string | undefined;
}

/**
 * Delivers messages — the one thing a transport does — and returns the provider's message id. A transport a package brings
 * (`static mailDrivers`) is responsible for its own route to the provider, TLS included. See `docs/drivers.md#mail-transports`.
 */
export interface MailTransport {
  send(message: MailMessage): Promise<MailReceipt>;
  /** Closes connections the transport holds; the framework calls it at shutdown, when the transport was built. */
  close?(): Promise<void>;
}
export const MailTransport = token<MailTransport>('MailTransport');

/** What a {@link MailDriverFactory} is given. */
export interface MailDriverContext {
  /** The name the driver was registered under (`MAIL_DRIVER=ses`). */
  readonly name: string;
  readonly container: Resolver;
  /** Writes to the log on the `mail` channel. */
  readonly logger: Logger;
}

/** Creates a mail transport: `static mailDrivers = { ses: (context) => … }` on a service provider. */
export type MailDriverFactory = (context: MailDriverContext) => MailTransport;

const NO_RECEIPT: MailReceipt = Object.freeze({ messageId: undefined });

/** Writes every message to the log instead of sending it (`MAIL_DRIVER=log`, the default). */
export class LogTransport implements MailTransport {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger.child({ channel: 'mail' });
  }

  async send(message: MailMessage): Promise<MailReceipt> {
    const to = message.to.map((recipient) => recipient.address).join(', ');
    // The text version in full: in development, links in mails (password reset, verification) are clicked from here.
    this.#logger.info(`Mail to ${to}: ${message.subject}\n\n${message.text}\n`, { to, subject: message.subject });
    return NO_RECEIPT;
  }
}

/** Keeps messages in memory (`MAIL_DRIVER=array`) — for tests and tools that inspect what would have been sent. */
export class ArrayTransport implements MailTransport {
  readonly messages: MailMessage[] = [];

  async send(message: MailMessage): Promise<MailReceipt> {
    this.messages.push(message);
    return NO_RECEIPT;
  }

  clear(): void {
    this.messages.length = 0;
  }
}

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS from the first byte (port 465). Otherwise the connection is upgraded with STARTTLS. */
  readonly secure: boolean;
  /**
   * Without `secure`: refuse to send unless the server upgrades to TLS (STARTTLS) — default `true`. Without it, a server
   * without STARTTLS (or someone who strips the offer) gets the credentials and the mails in plain text. `false` only for a
   * local server without TLS (Mailpit).
   */
  readonly requireTls?: boolean;
  readonly username?: string;
  readonly password?: string;
}

/** The part of nodemailer this transport uses — its own types never reach the API. */
interface NodemailerTransporter {
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: unknown } | undefined>;
  close(): void;
}

/** SMTP through nodemailer, imported on first use (`MAIL_DRIVER=smtp`). Nothing of nodemailer is visible outside this class. */
export class SmtpTransport implements MailTransport {
  readonly #options: SmtpOptions;
  #transporter: Promise<NodemailerTransporter> | undefined;

  constructor(options: SmtpOptions) {
    this.#options = options;
  }

  async send(message: MailMessage): Promise<MailReceipt> {
    const transporter = await (this.#transporter ??= this.#connect());
    const address = (recipient: { address: string; name?: string }) => (recipient.name ? { name: recipient.name, address: recipient.address } : recipient.address);
    const info = await transporter.sendMail({
      from: address(message.from),
      to: message.to.map(address),
      cc: message.cc.map(address),
      bcc: message.bcc.map(address),
      ...(message.replyTo ? { replyTo: address(message.replyTo) } : {}),
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
      attachments: message.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: typeof attachment.content === 'string' ? attachment.content : Buffer.from(attachment.content),
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      })),
    });
    return { messageId: typeof info?.messageId === 'string' ? info.messageId : undefined };
  }

  /** Closes pooled connections (the provider calls it on shutdown). */
  async close(): Promise<void> {
    if (this.#transporter) (await this.#transporter).close();
  }

  async #connect(): Promise<NodemailerTransporter> {
    // `as string`: nodemailer ships no types (and @types/nodemailer would be one more dependency for one call).
    const nodemailer = ((await import('nodemailer' as string)) as { default: { createTransport(options: Record<string, unknown>): NodemailerTransporter } }).default;
    const { host, port, secure, requireTls = true, username, password } = this.#options;
    return nodemailer.createTransport({ host, port, secure, requireTLS: !secure && requireTls, ...(username ? { auth: { user: username, pass: password ?? '' } } : {}) });
  }
}

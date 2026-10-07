import { Logger, token } from '@marmeon/core';
import type { MailMessage } from './message.ts';

/**
 * Delivers messages (E29) — the one thing a transport does. SMTP, a log, an array; HTTP APIs
 * (Postmark, SES, Resend …) and failover are further transports, later.
 */
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}
export const MailTransport = token<MailTransport>('MailTransport');

/** Writes every message to the log instead of sending it — the default in development (`MAIL_MAILER=log`). */
export class LogTransport implements MailTransport {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger.child({ channel: 'mail' });
  }

  async send(message: MailMessage): Promise<void> {
    const to = message.to.map((recipient) => recipient.address).join(', ');
    // The text version in full: in development, links in mails (password reset, verification) are clicked from here.
    this.#logger.info(`Mail to ${to}: ${message.subject}\n\n${message.text}\n`, { to, subject: message.subject });
  }
}

/** Keeps messages in memory (`MAIL_MAILER=array`) — for tests and tools that inspect what would have been sent. */
export class ArrayTransport implements MailTransport {
  readonly messages: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.messages.push(message);
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
   * Without `secure`: refuse to send unless the server upgrades to TLS (STARTTLS) — default `true` (E192). Without it, a server
   * that does not offer STARTTLS — or someone on the network who strips the offer — gets the credentials and the mails (reset
   * links) in plain text. `false` only for a local server without TLS (Mailpit): `MAIL_REQUIRE_TLS=false`.
   */
  readonly requireTls?: boolean;
  readonly username?: string;
  readonly password?: string;
}

/** The part of nodemailer this transport uses — its own types never reach the API. */
interface NodemailerTransporter {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/**
 * SMTP through nodemailer — a dependency of this package (E198: the production path, no dependencies of its own), imported
 * on first use (`MAIL_MAILER=smtp`). Nothing of nodemailer is visible outside this class.
 */
export class SmtpTransport implements MailTransport {
  readonly #options: SmtpOptions;
  #transporter: Promise<NodemailerTransporter> | undefined;

  constructor(options: SmtpOptions) {
    this.#options = options;
  }

  async send(message: MailMessage): Promise<void> {
    const transporter = await (this.#transporter ??= this.#connect());
    const address = (recipient: { address: string; name?: string }) => (recipient.name ? { name: recipient.name, address: recipient.address } : recipient.address);
    await transporter.sendMail({
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

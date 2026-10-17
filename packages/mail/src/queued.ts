import type { Application, StandardSchemaV1 } from '@marmeon/core';
import type { JobContext } from '@marmeon/queue';
import * as v from 'valibot';
import type { Attachment, MailMessage } from './message.ts';
import { traceMail } from './trace.ts';
import type { MailTransport } from './transports.ts';

const address = v.object({ address: v.string(), name: v.optional(v.string()) });

const message = v.object({
  from: address,
  to: v.array(address),
  cc: v.array(address),
  bcc: v.array(address),
  replyTo: v.optional(address),
  subject: v.string(),
  html: v.string(),
  text: v.string(),
  attachments: v.array(v.object({ filename: v.string(), content: v.string(), encoding: v.picklist(['utf8', 'base64']), contentType: v.optional(v.string()) })),
  headers: v.record(v.string(), v.string()),
});

/** An address as the queue keeps it. */
export interface QueuedMailAddress {
  address: string;
  name?: string | undefined;
}

/** A composed message as the queue keeps it: JSON, attachments as text or base64. */
export interface QueuedMailMessage {
  from: QueuedMailAddress;
  to: QueuedMailAddress[];
  cc: QueuedMailAddress[];
  bcc: QueuedMailAddress[];
  replyTo?: QueuedMailAddress | undefined;
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; content: string; encoding: 'utf8' | 'base64'; contentType?: string | undefined }[];
  headers: Record<string, string>;
}

/** What a queued mail carries: the composed message and, for logs, the mailable's class name. */
export interface QueuedMailPayload {
  mailable: string;
  message: QueuedMailMessage;
}

/** @internal The validation behind `SendQueuedMail.schema`; the type tests compare its output with `QueuedMailPayload`. */
export const queuedMailSchema = v.object({ mailable: v.string(), message });

/**
 * The framework job behind `mailer.queue(mail)`: hands the message composed where it was queued to the transport.
 * **Encrypted** (APP_KEY): a queued mail carries what only its recipient may see, such as a reset link, so `marmeon_jobs` and
 * `marmeon_failed_jobs` keep only ciphertext. Delivery is at-least-once. See `docs/mail.md#sending-mails`.
 */
export class SendQueuedMail {
  static readonly job = 'marmeon.mail';
  static readonly schema: StandardSchemaV1<QueuedMailPayload> = queuedMailSchema;
  static readonly encrypted = true;
  static readonly tries = 5;
  static readonly backoff = [10, 60, 300];
  static readonly timeout = 30;

  readonly #transport: MailTransport;
  readonly #app: Application | undefined;

  constructor(transport: MailTransport, app?: Application) {
    this.#transport = transport;
    this.#app = app;
  }

  async handle(payload: QueuedMailPayload, _job: JobContext): Promise<void> {
    await traceMail(this.#app, payload.mailable, 'worker', async () => {
      const message = fromQueued(payload.message);
      await this.#transport.send(message);
      return message;
    });
  }
}

/** A message as the queue keeps it — binary attachments as base64. */
export function toQueued(message: MailMessage): QueuedMailMessage {
  return {
    from: plain(message.from),
    to: message.to.map(plain),
    cc: message.cc.map(plain),
    bcc: message.bcc.map(plain),
    ...(message.replyTo ? { replyTo: plain(message.replyTo) } : {}),
    subject: message.subject,
    html: message.html,
    text: message.text,
    attachments: message.attachments.map((attachment) => ({
      filename: attachment.filename,
      ...(typeof attachment.content === 'string'
        ? { content: attachment.content, encoding: 'utf8' as const }
        : { content: Buffer.from(attachment.content).toString('base64'), encoding: 'base64' as const }),
      ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
    })),
    headers: { ...message.headers },
  };
}

/** The message back from the queue. */
export function fromQueued(queued: QueuedMailMessage): MailMessage {
  return {
    from: plain(queued.from),
    to: queued.to.map(plain),
    cc: queued.cc.map(plain),
    bcc: queued.bcc.map(plain),
    ...(queued.replyTo ? { replyTo: plain(queued.replyTo) } : {}),
    subject: queued.subject,
    html: queued.html,
    text: queued.text,
    attachments: queued.attachments.map(
      (attachment): Attachment => ({
        filename: attachment.filename,
        content: attachment.encoding === 'base64' ? new Uint8Array(Buffer.from(attachment.content, 'base64')) : attachment.content,
        ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
      }),
    ),
    headers: { ...queued.headers },
  };
}

function plain(value: { readonly address: string; readonly name?: string | undefined }): { address: string; name?: string } {
  return value.name === undefined ? { address: value.address } : { address: value.address, name: value.name };
}

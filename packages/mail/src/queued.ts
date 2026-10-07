import type { Application } from '@marmeon/core';
import type { JobContext } from '@marmeon/queue';
import * as v from 'valibot';
import type { Attachment, MailMessage } from './message.ts';
import { traceMail } from './trace.ts';
import type { MailTransport } from './transports.ts';

const address = v.object({ address: v.string(), name: v.optional(v.string()) });

/** A composed message as the queue keeps it: JSON, attachments as text or base64. */
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

/** What a queued mail carries: the composed message and, for logs, the mailable's class name. */
export type QueuedMailPayload = v.InferOutput<typeof SendQueuedMail.schema>;

/**
 * The framework job behind `mailer.queue(mail)` (E105): the message composed where it was queued — in the recipient's
 * language, with its links — handed to the transport by a worker. **Encrypted**: a queued mail carries what its
 * recipient may see and nobody else (a reset link, a signed verification link), and the `jobs`/`failed_jobs` tables
 * keep only ciphertext of it (APP_KEY).
 *
 * Five attempts — 10 s, 1 min, 5 min apart (an SMTP server that is down for a while); then it waits in the failed jobs
 * for `marmeon queue:retry`. Delivery is at-least-once (E85): a worker that dies after the transport took the mail and
 * before the acknowledgement sends it again.
 */
export class SendQueuedMail {
  static readonly job = 'marmeon.mail';
  static readonly schema = v.object({ mailable: v.string(), message });
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
export function toQueued(message: MailMessage): QueuedMailPayload['message'] {
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
export function fromQueued(queued: QueuedMailPayload['message']): MailMessage {
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

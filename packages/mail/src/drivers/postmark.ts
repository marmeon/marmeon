import type { Clock } from '@marmeon/core';
import type { HttpClient } from '@marmeon/fetch';
import type { MailMessage } from '../message.ts';
import type { MailReceipt, MailSendOptions, MailTransport } from '../transports.ts';
import { checkAttachments, checkHeaders, formatAddress, messageIdOf, postJson, type FetchModule } from './api.ts';

const ENDPOINT = 'https://api.postmarkapp.com/email';

export interface PostmarkOptions {
  /** The server API token (`MAIL_POSTMARK_TOKEN`). */
  readonly token: string;
  /** Resolved for every request, so a test's `HttpClientFake` is the one used. */
  readonly http: () => HttpClient;
  readonly fetch: FetchModule;
  readonly clock: Clock;
}

/** The error code of an error answer: `ErrorCode`, a non-negative whole number. */
function codeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { ErrorCode } = body as { ErrorCode?: unknown };
  return typeof ErrorCode === 'number' && Number.isSafeInteger(ErrorCode) && ErrorCode >= 0 ? String(ErrorCode) : undefined;
}

/**
 * Sends mail through the Postmark API (`MAIL_DRIVER=postmark`) with the `HttpClient` of @marmeon/fetch, to a fixed address. The token
 * is held privately and goes into one request header; it is in no message, log or `cause`. Postmark has no idempotency key, so
 * `idempotencyKey` is ignored: a retry after a lost answer can send the mail twice. See `docs/mail.md#postmark`.
 * @internal
 */
export class PostmarkTransport implements MailTransport {
  readonly #token: string;
  readonly #http: () => HttpClient;
  readonly #fetch: FetchModule;
  readonly #clock: Clock;

  constructor(options: PostmarkOptions) {
    this.#token = options.token;
    this.#http = options.http;
    this.#fetch = options.fetch;
    this.#clock = options.clock;
  }

  async send(message: MailMessage, options?: MailSendOptions): Promise<MailReceipt> {
    // Before any request: the addresses and headers are checked first.
    const headers = checkHeaders(message.headers, 'postmark');
    const attachments = checkAttachments(message.attachments);
    const list = (recipients: MailMessage['to']) => recipients.map(formatAddress).join(', ');
    const json = {
      From: formatAddress(message.from),
      To: list(message.to),
      ...(message.cc.length > 0 ? { Cc: list(message.cc) } : {}),
      ...(message.bcc.length > 0 ? { Bcc: list(message.bcc) } : {}),
      ...(message.replyTo ? { ReplyTo: formatAddress(message.replyTo) } : {}),
      Subject: message.subject,
      HtmlBody: message.html,
      TextBody: message.text,
      ...(headers.length > 0 ? { Headers: headers.map(({ name, value }) => ({ Name: name, Value: value })) } : {}),
      ...(attachments.length > 0
        ? {
            Attachments: attachments.map((attachment) => ({
              Name: attachment.filename,
              Content: attachment.content.toString('base64'),
              ContentType: attachment.contentType ?? 'application/octet-stream',
            })),
          }
        : {}),
    };
    const body = await postJson({
      http: this.#http,
      fetch: this.#fetch,
      clock: this.#clock,
      driver: 'postmark',
      credential: 'MAIL_POSTMARK_TOKEN',
      url: ENDPOINT,
      headers: { 'x-postmark-server-token': this.#token },
      json,
      signal: options?.signal,
      codeOf,
    });
    const { MessageID } = typeof body === 'object' && body !== null ? (body as { MessageID?: unknown }) : {};
    return { messageId: messageIdOf(MessageID) };
  }
}

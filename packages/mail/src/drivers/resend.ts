import type { Clock } from '@marmeon/core';
import type { HttpClient } from '@marmeon/fetch';
import { MailDeliveryError } from '../mailer.ts';
import type { MailMessage } from '../message.ts';
import type { MailReceipt, MailSendOptions, MailTransport } from '../transports.ts';
import { checkAttachments, checkHeaders, checkSubject, formatAddress, messageIdOf, postJson, type FetchModule } from './api.ts';

const ENDPOINT = 'https://api.resend.com/emails';

export interface ResendOptions {
  /** The API key (`MAIL_RESEND_API_KEY`). */
  readonly apiKey: string;
  /** Resolved for every request, so a test's `HttpClientFake` is the one used. */
  readonly http: () => HttpClient;
  readonly fetch: FetchModule;
  readonly clock: Clock;
}

/** The error name of an error answer (`validation_error`, `rate_limit_exceeded` …). */
function codeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { name } = body as { name?: unknown };
  return typeof name === 'string' && /^[a-z_]{1,64}$/.test(name) ? name : undefined;
}

/**
 * Sends mail through the Resend API (`MAIL_DRIVER=resend`) with the `HttpClient` of @marmeon/fetch, to a fixed address. The key is
 * held privately and goes into one request header; it is in no message, log or `cause`. `idempotencyKey` becomes Resend's
 * `Idempotency-Key`, so a retry after a lost answer does not send the mail twice. See `docs/mail.md#resend`.
 * @internal
 */
export class ResendTransport implements MailTransport {
  readonly #apiKey: string;
  readonly #http: () => HttpClient;
  readonly #fetch: FetchModule;
  readonly #clock: Clock;

  constructor(options: ResendOptions) {
    this.#apiKey = options.apiKey;
    this.#http = options.http;
    this.#fetch = options.fetch;
    this.#clock = options.clock;
  }

  async send(message: MailMessage, options?: MailSendOptions): Promise<MailReceipt> {
    const headers = checkHeaders(message.headers, 'resend');
    const attachments = checkAttachments(message.attachments);
    const key = options?.idempotencyKey;
    // Headers throws on a value it cannot hold, which would read as a failure to retry; a key of 1 to 256 printable characters is what
    // Resend takes. `typeof`: a JS caller's `null` or number would pass the pattern as its text.
    if (key !== undefined && (typeof key !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(key))) {
      throw new MailDeliveryError('refused', 'The mail was refused: the idempotency key is not 1 to 256 printable characters.');
    }
    const list = (recipients: MailMessage['to']) => recipients.map(formatAddress);
    const json = {
      from: formatAddress(message.from),
      to: list(message.to),
      ...(message.cc.length > 0 ? { cc: list(message.cc) } : {}),
      ...(message.bcc.length > 0 ? { bcc: list(message.bcc) } : {}),
      ...(message.replyTo ? { reply_to: formatAddress(message.replyTo) } : {}),
      subject: checkSubject(message.subject),
      html: message.html,
      text: message.text,
      ...(headers.length > 0 ? { headers: Object.fromEntries(headers.map(({ name, value }) => [name, value])) } : {}),
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((attachment) => ({
              filename: attachment.filename,
              content: attachment.content.toString('base64'),
              ...(attachment.contentType === undefined ? {} : { content_type: attachment.contentType }),
            })),
          }
        : {}),
    };
    const body = await postJson({
      http: this.#http,
      fetch: this.#fetch,
      clock: this.#clock,
      driver: 'resend',
      credential: 'MAIL_RESEND_API_KEY',
      url: ENDPOINT,
      headers: { authorization: `Bearer ${this.#apiKey}`, ...(key === undefined ? {} : { 'idempotency-key': key }) },
      json,
      signal: options?.signal,
      codeOf,
      // The same key with another payload never succeeds: a 409 of that name is no retry's business (the other 409 is).
      reasonOf: (status, code) => (status === 409 && code === 'invalid_idempotent_request' ? 'rejected' : undefined),
    });
    const { id } = typeof body === 'object' && body !== null ? (body as { id?: unknown }) : {};
    return { messageId: messageIdOf(id) };
  }
}

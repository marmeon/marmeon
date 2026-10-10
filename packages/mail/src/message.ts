import type { Html } from './html.ts';

/** An address: `'ada@example.com'` or `{ address: 'ada@example.com', name: 'Ada Lovelace' }`. */
export type Address = string | { readonly address: string; readonly name?: string };

export interface Attachment {
  readonly filename: string;
  readonly content: string | Uint8Array;
  readonly contentType?: string;
}

/** A message as transports send it — a neutral type, so no transport library's types leak into the API. */
export interface MailMessage {
  readonly from: { readonly address: string; readonly name?: string };
  readonly to: readonly { readonly address: string; readonly name?: string }[];
  readonly cc: readonly { readonly address: string; readonly name?: string }[];
  readonly bcc: readonly { readonly address: string; readonly name?: string }[];
  readonly replyTo?: { readonly address: string; readonly name?: string };
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly headers: Readonly<Record<string, string>>;
}

/** Who gets a mail and what it is about — `envelope()` of a {@link Mailable}. */
export interface Envelope {
  readonly to: Address | readonly Address[];
  readonly subject: string;
  readonly from?: Address;
  readonly cc?: Address | readonly Address[];
  readonly bcc?: Address | readonly Address[];
  readonly replyTo?: Address;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The body: HTML and plain text. `content()` may also return an `mjml` or `html` template; the text version is then
 * derived (`fromMjml`/`fromHtml` to give one).
 */
export interface MailContent {
  readonly html: string;
  readonly text: string;
}

/**
 * A mail as a class: data through the constructor, the envelope and the content as methods.
 * See `docs/mail.md#writing-mails`.
 */
export interface Mailable {
  envelope(): Envelope | Promise<Envelope>;
  content(): MailContent | Html | Promise<MailContent | Html>;
  attachments?(): readonly Attachment[] | Promise<readonly Attachment[]>;
}

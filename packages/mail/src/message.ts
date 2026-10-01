import type { Html } from './html.ts';

/** An address: `'ada@example.com'` or `{ address: 'ada@example.com', name: 'Ada Lovelace' }`. */
export type Address = string | { readonly address: string; readonly name?: string };

export interface Attachment {
  readonly filename: string;
  readonly content: string | Uint8Array;
  readonly contentType?: string;
}

/**
 * A message as transports send it — our own, neutral type (E29): no transport library's types leak
 * into the API, so transports (SMTP today, HTTP APIs later) are interchangeable.
 */
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
 * The body — HTML and plain text, nothing else (E29): this package knows no UI library. `content()` may
 * also return an `mjml` or `html` template; the text version is then derived (`fromMjml`/`fromHtml` to give one).
 */
export interface MailContent {
  readonly html: string;
  readonly text: string;
}

/**
 * A mail as a class — like a controller or a listener (E11): data through the constructor, the
 * envelope and the content as methods.
 *
 * ```ts
 * export class WelcomeMail implements Mailable {
 *   readonly #user: User;
 *   constructor(user: User) { this.#user = user; }
 *   envelope() { return { to: this.#user.email, subject: 'Welcome' }; }
 *   content() { return mjml`<mjml><mj-body><mj-section><mj-column><mj-text>Hello ${this.#user.name}</mj-text></mj-column></mj-section></mj-body></mjml>`; }
 * }
 * ```
 */
export interface Mailable {
  envelope(): Envelope | Promise<Envelope>;
  content(): MailContent | Html | Promise<MailContent | Html>;
  attachments?(): readonly Attachment[] | Promise<readonly Attachment[]>;
}

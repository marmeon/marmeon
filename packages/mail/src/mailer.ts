import { token, type Application, type Duration } from '@marmeon/core';
import { fromHtml, Html } from './html.ts';
import type { Address, Mailable, MailContent, MailMessage } from './message.ts';
import { fromMjml, Mjml } from './mjml.ts';
import { toQueued, type QueuedMailPayload } from './queued.ts';
import { traceMail } from './trace.ts';
import type { MailTransport } from './transports.ts';

/** Where and when a queued mail goes (`mailer.queue(mail, options)`). */
export interface QueueMailOptions {
  /** The queue (default: the connection's default queue). A worker without `--queue` takes it; one with `--queue` must name it. */
  readonly queue?: string;
  /** Send no earlier than this — seconds, or a duration (`{ minutes: 5 }`). */
  readonly delay?: number | Duration;
  /** The queue connection (default: `QUEUE_CONNECTION`). */
  readonly connection?: string;
}

/**
 * Sends mailables — `constructor(mailer: Mailer)`, then:
 *
 * ```ts
 * await this.#mailer.send(new WelcomeMail(user, url, t));                       // now: composed and handed to the transport
 * await this.#mailer.queue(new ResetPasswordMail(user, url, t), { queue: 'mail' }); // composed now, sent by a worker
 * ```
 */
export interface Mailer {
  send(mailable: Mailable): Promise<MailMessage>;
  /**
   * Composes the mail **now** — its language, its links, its content: the recipient's translator and absolute links
   * (from `APP_URL`) belong in the mailable — and queues the message for a worker to hand to the transport (E105). The
   * request does not wait for the mail server, and an SMTP failure retries in the worker instead of failing the request.
   * The queued message is **encrypted** (`jobs`/`failed_jobs` keep no reset link in plain text). Inside
   * `connections.transaction()` it is queued only if the transaction commits. Resolves with the composed message.
   * Needs @marmeon/queue (and APP_KEY).
   */
  queue(mailable: Mailable, options?: QueueMailOptions): Promise<MailMessage>;
}
export const Mailer = token<Mailer>('Mailer');

/** Puts a composed mail on the queue — the `marmeon.mail` job (`MailServiceProvider` wires it to @marmeon/queue). */
export type MailQueue = (payload: QueuedMailPayload, options: QueueMailOptions) => Promise<unknown>;

export class MailError extends Error {
  override name = 'MailError';
}

/** A message from a mailable: addresses normalized and checked, the default sender filled in. */
export async function compose(mailable: Mailable, defaultFrom: Address): Promise<MailMessage> {
  const envelope = await mailable.envelope();
  const content = await contentOf(mailable);
  const to = addresses(envelope.to);
  if (to.length === 0) throw new MailError(`${mailable.constructor.name} has no recipient.`);
  const headers = { ...envelope.headers };
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new MailError(`Invalid mail header name "${name}".`);
    singleLine(value, `header ${name}`);
  }
  checkLinks(mailable, content.html);
  return {
    from: address(envelope.from ?? defaultFrom),
    to,
    cc: addresses(envelope.cc),
    bcc: addresses(envelope.bcc),
    ...(envelope.replyTo ? { replyTo: address(envelope.replyTo) } : {}),
    subject: singleLine(envelope.subject, 'subject'),
    html: content.html,
    text: content.text,
    attachments: (await mailable.attachments?.()) ?? [],
    headers,
  };
}

/**
 * The default `Mailer`: composes, then hands the message to the configured transport — now (`send`), or through the queue
 * (`queue`). The transport is built on first use: an app that only queues mails never opens an SMTP connection in its
 * web process.
 */
export class TransportMailer implements Mailer {
  readonly #transport: () => MailTransport;
  readonly #from: Address;
  readonly #queue: MailQueue | undefined;
  readonly #app: Application | undefined;

  /** `app`: the mails are reported on its `mail.send` channel (E118). */
  constructor(transport: MailTransport | (() => MailTransport), from: Address, queue?: MailQueue, app?: Application) {
    this.#transport = typeof transport === 'function' ? transport : () => transport;
    this.#from = from;
    this.#queue = queue;
    this.#app = app;
  }

  send(mailable: Mailable): Promise<MailMessage> {
    return traceMail(this.#app, mailable.constructor.name, 'send', async () => {
      const message = await compose(mailable, this.#from);
      await this.#transport().send(message);
      return message;
    });
  }

  async queue(mailable: Mailable, options: QueueMailOptions = {}): Promise<MailMessage> {
    if (!this.#queue) throw new MailError('mailer.queue() needs @marmeon/queue (pnpm add @marmeon/queue; marmeon discover) — or send the mail now: mailer.send().');
    const queue = this.#queue;
    return traceMail(this.#app, mailable.constructor.name, 'queue', async () => {
      const message = await compose(mailable, this.#from);
      await queue({ mailable: mailable.constructor.name, message: toQueued(message) }, options);
      return message;
    });
  }
}

/** The mail's tags — the attributes are inside them; text (escaped) never is. */
const TAG = /<[a-z][^>]*>/gi;
/** Every `href` and `src` of a tag, quoted or not. */
const LINK = /(?<![\w-])(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
/** What a mail client can follow: a scheme (`https:`, `mailto:`, `tel:`, `cid:`) — or a place in the mail itself (`#top`). */
const ABSOLUTE = /^(?:[a-z][a-z\d+.-]*:|#)/i;

/**
 * Links in a mail are absolute — a mail client has no page to resolve `/users/me` or `notes/7` against, and a mail composed in a
 * worker has no request whose host could fill one in (nor should a Host header ever decide where a link points). Every link
 * without a scheme is refused, `//host/…` too: whatever the mail client would guess.
 */
function checkLinks(mailable: Mailable, html: string): void {
  for (const [tag] of html.matchAll(TAG)) {
    for (const match of tag.matchAll(LINK)) {
      const link = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (ABSOLUTE.test(link)) continue;
      throw new MailError(
        `${mailable.constructor.name} links to "${link}" — a link in a mail must be absolute. Build it from APP_URL: new URL(path, config.url).href, or a signed URL with { base: config.url }.`,
      );
    }
  }
}

async function contentOf(mailable: Mailable): Promise<MailContent> {
  const content = await mailable.content();
  if (content instanceof Mjml) return fromMjml(content);
  if (content instanceof Html) return fromHtml(content);
  if (typeof content?.html !== 'string' || typeof content?.text !== 'string') {
    throw new MailError(`${mailable.constructor.name}.content() must return mjml\`…\`, html\`…\` or { html, text } strings.`);
  }
  return content;
}

function addresses(value: Address | readonly Address[] | undefined): { address: string; name?: string }[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value as Address]).map(address);
}

const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/;

function address(value: Address): { address: string; name?: string } {
  const { address: email, name } = typeof value === 'string' ? { address: value, name: undefined } : value;
  if (!EMAIL.test(email)) throw new MailError(`Invalid mail address "${email}".`);
  return name === undefined ? { address: email } : { address: email, name: singleLine(name, 'address name') };
}

/** No line breaks where a header goes: a "\r\nBcc: …" in a subject would add recipients (header injection). */
function singleLine(value: string, what: string): string {
  if (/[\r\n]/.test(value)) throw new MailError(`The mail's ${what} must be a single line.`);
  return value;
}

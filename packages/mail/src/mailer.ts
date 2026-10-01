import { token } from '@bespokecore/core';
import { fromHtml, Html } from './html.ts';
import type { Address, Mailable, MailContent, MailMessage } from './message.ts';
import { fromMjml, Mjml } from './mjml.ts';
import { MailTransport } from './transports.ts';

/** Sends mailables — `constructor(mailer: Mailer)`, then `await mailer.send(new ResetPasswordMail(user, url))`. */
export interface Mailer {
  send(mailable: Mailable): Promise<MailMessage>;
}
export const Mailer = token<Mailer>('Mailer');

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

/** The default `Mailer`: composes, then hands the message to the configured transport. */
export class TransportMailer implements Mailer {
  readonly #transport: MailTransport;
  readonly #from: Address;

  constructor(transport: MailTransport, from: Address) {
    this.#transport = transport;
    this.#from = from;
  }

  async send(mailable: Mailable): Promise<MailMessage> {
    const message = await compose(mailable, this.#from);
    await this.#transport.send(message);
    return message;
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

import type { Clock } from '@marmeon/core';
import type { HttpClient } from '@marmeon/fetch';
import { MailDeliveryError } from '../mailer.ts';
import type { MailMessage } from '../message.ts';

export type FetchModule = typeof import('@marmeon/fetch');

/**
 * @marmeon/fetch is an optional peer: only the API drivers need it, so only it is imported lazily, once one is chosen. The driver
 * files load with the package and name it as a type only. `undefined` only when the package itself is missing (the importer's path
 * may name it, and so may another missing package's error). `load` is the import, replaceable by a test.
 * @internal
 */
export async function importFetch(load: () => Promise<FetchModule> = () => import('@marmeon/fetch')): Promise<FetchModule | undefined> {
  try {
    return await load();
  } catch (error) {
    const missing = /Cannot find (?:package|module) '@marmeon\/fetch'/;
    if ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && missing.test(String((error as Error).message))) return undefined;
    throw error;
  }
}

const PLAIN_ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
// An encoded-word is at most 75 characters; `=?UTF-8?B?` and `?=` take 12 and base64 4 for every 3 bytes: 45 bytes a word.
const WORD_BYTES = 45;

/**
 * An address as one recipient string of a provider's API: `ada@example.com`, or `"Ada, Lovelace" <ada@example.com>` — the name
 * quoted (RFC 5322, `\` and `"` escaped), or as RFC 2047 encoded-words when it is not printable ASCII. Without that, a name such as
 * `Evil, x@attacker.example` would be one more recipient in a comma-separated list. A name the framework did not compose is quoted too;
 * an address that is not a plain `local@host` is refused.
 * @internal
 */
export function formatAddress(recipient: { readonly address: string; readonly name?: string }): string {
  if (!PLAIN_ADDRESS.test(recipient.address)) throw new MailDeliveryError('refused', 'The mail was refused: an address is not a plain e-mail address.');
  const { name } = recipient;
  if (name === undefined || name === '') return recipient.address;
  if (PRINTABLE_ASCII.test(name)) return `"${name.replace(/[\\"]/g, '\\$&')}" <${recipient.address}>`;
  const words: string[] = [];
  let chunk = '';
  for (const character of name) {
    if (chunk !== '' && Buffer.byteLength(chunk + character) > WORD_BYTES) {
      words.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  words.push(chunk);
  return `${words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join(' ')} <${recipient.address}>`;
}

/** Headers that address the mail or shape its structure: a provider's API sets them itself, from the fields it has for them. */
const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'sender',
  'subject',
  'date',
  'message-id',
  'return-path',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
]);

/**
 * Refuses, before any request, a header that addresses the mail or shapes its structure — `envelope().headers` with a `Bcc` would
 * add a hidden recipient — and a header that is not a plain single line. Returns the headers as name and value pairs.
 * @internal
 */
export function checkHeaders(headers: Readonly<Record<string, string>>, driver: string): { name: string; value: string }[] {
  const checked: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) {
      throw new MailDeliveryError('refused', `The mail was refused: a header is not a plain name with a single-line value.`);
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new MailDeliveryError('refused', `The mail was refused: the header "${name}" addresses or shapes the mail, and the ${driver} driver sets that itself from the envelope.`);
    }
    checked.push({ name, value });
  }
  return checked;
}

/**
 * Refuses, before any request, an attachment whose `filename` or `contentType` is not a single-line string: the provider puts both
 * into the MIME headers of the part, where a line break would add a header. Returns the attachments' fields as the transport sends them.
 * @internal
 */
export function checkAttachments(attachments: MailMessage['attachments']): { filename: string; contentType: string | undefined; content: Buffer }[] {
  return attachments.map((attachment) => {
    const { filename, contentType } = attachment as { filename: unknown; contentType: unknown };
    if (typeof filename !== 'string' || /[\r\n]/.test(filename) || (contentType !== undefined && (typeof contentType !== 'string' || /[\r\n]/.test(contentType)))) {
      throw new MailDeliveryError('refused', 'The mail was refused: an attachment\'s filename or content type is not a single line of text.');
    }
    return { filename, contentType: contentType as string | undefined, content: Buffer.from(attachment.content) };
  });
}

const MAX_RETRY_AFTER = 3600;
const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * The seconds a `Retry-After` header asks for: delta seconds (decimals rounded up) or an HTTP date minus now, clamped to 1 to 3600;
 * `undefined` for a header that is absent or is neither.
 * @internal
 */
export function retryAfterSeconds(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  let seconds: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) seconds = Number(text);
  else if (HTTP_DATE.test(text)) seconds = (Date.parse(text) - now) / 1000;
  else return undefined;
  if (Number.isNaN(seconds)) return undefined;
  return Math.min(MAX_RETRY_AFTER, Math.max(1, Math.ceil(seconds)));
}

/** A message id the provider gave, when it is plain printable text of a sane length; anything else is no id. @internal */
export function messageIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value) ? value : undefined;
}

export interface PostJsonOptions {
  /** Resolved for every request, so a test's `HttpClientFake` is the one used. */
  readonly http: () => HttpClient;
  readonly fetch: FetchModule;
  readonly clock: Clock;
  /** The driver's name, for messages. */
  readonly driver: string;
  /** The setting that holds the credential, named when the provider refuses it. */
  readonly credential: string;
  /** The fixed endpoint of the provider. */
  readonly url: string;
  /** The credential header, besides `accept`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly json: unknown;
  readonly signal?: AbortSignal | undefined;
  /** The short error code an error answer names (`undefined` when it names none); only a plain short code is kept. */
  readonly codeOf: (body: unknown) => string | undefined;
  /** A reason that replaces the one the status gives, for an answer the provider's code says more about. */
  readonly reasonOf?: (status: number, code: string | undefined) => 'rejected' | undefined;
}

/**
 * Posts one JSON request to a provider's fixed address and returns the answer's parsed JSON — `undefined` for a success whose body is
 * not JSON, which never throws: the mail is with the provider. Throws a `MailDeliveryError` for everything else. The error holds the
 * driver, the status and a short provider code — never the answer's text (it can echo addresses and content), the request, a
 * credential or a `cause` (an error of the client can hold the address).
 * @internal
 */
export async function postJson(options: PostJsonOptions): Promise<unknown> {
  const { driver } = options;
  let response: Response;
  try {
    response = await options.http().fetch(options.url, {
      method: 'POST',
      json: options.json,
      redirect: 'error',
      timeout: 15,
      maxResponseBytes: 64 * 1024,
      headers: { accept: 'application/json', ...options.headers },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw failed(options.fetch, driver, error);
  }
  let text = '';
  try {
    text = await response.text();
  } catch {
    // an answer that cannot be read still has its status
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (response.status >= 200 && response.status < 300) return body;
  let code: string | undefined;
  try {
    code = options.codeOf(body);
  } catch {
    code = undefined;
  }
  if (code !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(code)) code = undefined;
  throw answered(options, response.status, code, response.headers.get('retry-after'));
}

function answered(options: PostJsonOptions, status: number, code: string | undefined, retryAfter: string | null): MailDeliveryError {
  let reason: 'unauthorized' | 'throttled' | 'unavailable' | 'rejected';
  let seconds: number | undefined;
  if (status === 401 || status === 403) {
    reason = 'unauthorized';
  } else if (status === 429) {
    reason = 'throttled';
    seconds = retryAfterSeconds(retryAfter, options.clock.now());
  } else if (status === 408 || status === 409 || status === 425 || status >= 500) {
    reason = 'unavailable';
    if (status === 503) seconds = retryAfterSeconds(retryAfter, options.clock.now());
  } else {
    reason = 'rejected';
  }
  if (options.reasonOf?.(status, code) === 'rejected') reason = 'rejected';
  const message =
    `The mail was not delivered: ${options.driver} answered ${status}${code === undefined ? '' : ` (${code})`}.` +
    (reason === 'unauthorized' ? ` Check ${options.credential}.` : '');
  return new MailDeliveryError(reason, message, {
    status,
    ...(code === undefined ? {} : { providerCode: code }),
    ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
  });
}

/** A request that did not complete. No cause is kept, and the message names the reason only. */
function failed(fetch: FetchModule, driver: string, error: unknown): MailDeliveryError {
  const base = `The mail was not delivered: the request to ${driver} `;
  if (!(error instanceof fetch.FetchError)) return new MailDeliveryError('unavailable', `${base}failed.`);
  if (error.reason === 'refused') return new MailDeliveryError('refused', `${base}was refused by the HTTP client.`);
  if (error.reason === 'redirects') return new MailDeliveryError('rejected', `${base}was answered with a redirect, which is not followed.`);
  return new MailDeliveryError('unavailable', `${base}${error.reason === 'timeout' ? 'timed out' : error.reason === 'aborted' ? 'was aborted' : 'failed'}.`);
}

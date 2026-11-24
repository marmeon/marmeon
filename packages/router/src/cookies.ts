import { durationToSeconds, type Duration } from '@marmeon/core';
import { editableResponse } from './response.ts';

export interface CookieOptions {
  /** Lifetime — seconds, or a duration; written as whole seconds, rounded down. Without `maxAge` and `expires`, the cookie ends with the browser session. */
  maxAge?: Duration;
  expires?: Date;
  /** Defaults to `/`. */
  path?: string;
  domain?: string;
  /**
   * HTTPS only. Defaults to the request's {@link CookieDefaults} — with `@marmeon/session`, `SESSION_SECURE_COOKIE`,
   * which follows `APP_URL` (`https:` → `true`) — else `false`. `false` here turns it off for this cookie.
   */
  secure?: boolean;
  /** Defaults to `true` — scripts cannot read the cookie. */
  httpOnly?: boolean;
  /** Defaults to `lax`. `none` requires `secure`. */
  sameSite?: 'lax' | 'strict' | 'none';
}

/**
 * @internal The session binds it and the kernel reads it. What every cookie of a request gets unless its `set` says otherwise: the kernel takes them
 * from the container (`CookieDefaults`, bound by `@marmeon/session` from its config).
 */
export interface CookieDefaults {
  /** `Secure` on every cookie that does not set `secure` itself. */
  readonly secure?: boolean;
}

/** RFC 6265 `token`: what a cookie name may consist of. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** `a=1; b=hello%20world` → `{ a: '1', b: 'hello world' }`. The first occurrence of a name wins. */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    // Only SP and HTAB are trimmed: `trim()` also strips U+00A0 and the like, which would turn a tossed `\u00A0__Host-x` into `__Host-x`.
    const name = trimSpaceAndTab(part.slice(0, index));
    if (!COOKIE_NAME.test(name) || cookies.has(name)) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1);
    cookies.set(name, safeDecode(value));
  }
  return cookies;
}

/**
 * Builds a `Set-Cookie` header value. The value is URI-encoded. It throws a TypeError for what {@link CookieJar.set} refuses
 * ([cookies](docs/responses.md#cookies)).
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const checked = checkCookie(name, options);
  checkValue(name, value);
  const { path = '/', domain, maxAge, expires, secure = false, httpOnly = true, sameSite = 'lax' } = checked;

  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (domain) parts.push(`Domain=${domain}`);
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (expires) parts.push(`Expires=${expires.toUTCString()}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  parts.push(`SameSite=${sameSite[0]!.toUpperCase()}${sameSite.slice(1)}`);
  return parts.join('; ');
}

/** The prefix (lower case; compared without regard to case) with which a browser accepts a cookie only if it is `Secure`, has `Path=/` and no `Domain`. */
const HOST_PREFIX = '__host-';

/** The prefix with which a browser accepts a cookie only if it is `Secure`. Prefixes match without regard to case. */
const SECURE_PREFIX = '__secure-';

/** Throws for a value that is not a string or has no UTF-8 form: `encodeURIComponent` would throw a `URIError` later, and the encrypting codec would store U+FFFD instead. */
function checkValue(name: string, value: string): void {
  if (typeof value !== 'string') throw new TypeError(`Cookie "${name}": the value must be a string.`);
  if (!value.isWellFormed()) throw new TypeError(`Cookie "${name}": the value has half of a surrogate pair — check it with wellFormed().`);
}

/**
 * `;`, the control characters (C0, DEL, C1) and every UTF-16 unit above U+00FF: `;` would end the attribute, and a `Headers` value takes bytes,
 * so a character above U+00FF can never be written. No `u` flag: with it an astral character is one code point past the range and would pass, then fail in `Headers`.
 */
// eslint-disable-next-line no-control-regex -- the class names the control characters it refuses
const UNSAFE_ATTRIBUTE = /[;\u0000-\u001f\u007f-\u009f\u0100-\uffff]/;

const SAME_SITE = ['lax', 'strict', 'none'];

/** Reads each option once, so a getter that answers differently later cannot change what was checked (and `{ ...options }` would drop a class's getters). */
function snapshot(options: CookieOptions | undefined): CookieOptions {
  const copy: CookieOptions = {};
  if (!options) return copy;
  const { path, domain, maxAge, expires, secure, httpOnly, sameSite } = options;
  if (path !== undefined) copy.path = path;
  if (domain !== undefined) copy.domain = domain;
  if (maxAge !== undefined) copy.maxAge = maxAge;
  if (expires !== undefined) copy.expires = expires;
  if (secure !== undefined) copy.secure = secure;
  if (httpOnly !== undefined) copy.httpOnly = httpOnly;
  if (sameSite !== undefined) copy.sameSite = sameSite;
  return copy;
}

/**
 * Throws for what `serializeCookie` and `CookieJar.set` refuse — an invalid name, a `path` or `domain` that cannot be written, an unknown
 * `sameSite`, a `maxAge` that is not a span of time, an `expires` that is not a valid date, `SameSite=None` without `secure`, a `__Secure-` or `__Host-` name that does not earn its prefix — without building the header.
 * Returns a copy of the options (each read once) that holds what was checked: `maxAge` as whole seconds and `expires` as a new `Date`, so the caller's objects
 * no longer matter.
 */
function checkCookie(name: string, given: CookieOptions | undefined, defaults: CookieDefaults = {}): CookieOptions {
  if (!COOKIE_NAME.test(name)) throw new TypeError(`Invalid cookie name "${name}".`);
  const checked = snapshot(given);
  if (defaults.secure && checked.secure === undefined) checked.secure = true;
  for (const key of ['path', 'domain'] as const) {
    const attribute = checked[key];
    if (attribute !== undefined && UNSAFE_ATTRIBUTE.test(attribute)) {
      throw new TypeError(`Cookie "${name}": the ${key} must not contain ";", a control character or a character above U+00FF.`);
    }
  }
  if (checked.maxAge !== undefined) {
    try {
      checked.maxAge = Math.floor(durationToSeconds(checked.maxAge));
    } catch (error) {
      throw new TypeError(`Cookie "${name}": maxAge is not a span of time — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (checked.expires !== undefined) {
    let time = Number.NaN;
    try {
      time = Date.prototype.getTime.call(checked.expires); // also a Date of another realm
    } catch {
      // not a Date: time stays NaN
    }
    if (Number.isNaN(time)) throw new TypeError(`Cookie "${name}": expires is not a valid date.`);
    checked.expires = new Date(time);
  }
  if (checked.sameSite !== undefined && !SAME_SITE.includes(checked.sameSite)) {
    throw new TypeError(`Cookie "${name}": sameSite must be "lax", "strict" or "none".`);
  }
  if (checked.sameSite === 'none' && !checked.secure) throw new TypeError(`Cookie "${name}": SameSite=None requires secure: true.`);
  // A browser refuses a `__Host-` cookie that is not Secure, has a Domain or a Path other than `/`; refusing it here too
  // means the prefix is never set on a cookie that does not earn it.
  const lower = name.toLowerCase();
  if (lower.startsWith(SECURE_PREFIX) && !checked.secure) throw new TypeError(`Cookie "${name}": the __Secure- prefix requires secure: true.`);
  if (lower.startsWith(HOST_PREFIX) && (!checked.secure || checked.domain || (checked.path ?? '/') !== '/')) {
    throw new TypeError(`Cookie "${name}": the __Host- prefix requires secure: true, path "/" and no domain.`);
  }
  return checked;
}

/**
 * Transforms cookie values on their way in and out — `EncryptCookies` installs
 * one that decrypts and encrypts. `decode` returning `undefined` drops the cookie.
 */
export interface CookieCodec {
  decode(name: string, value: string): Promise<string | undefined>;
  encode(name: string, value: string): Promise<string>;
}

/**
 * The cookies of one request: reads what the client sent, queues what the
 * response should set. Queued cookies are added to
 * whatever response the request ends with — a view, a redirect or an error page.
 *
 * `get` only sees cookies the client sent, not ones queued in this request.
 */
export class CookieJar {
  #incoming: Map<string, string>;
  readonly #queued = new Map<string, { value: string; options: CookieOptions | undefined }>();
  #codec: CookieCodec | undefined;
  #permit: ((what: string) => boolean) | undefined;
  readonly #defaults: CookieDefaults;

  /** @internal Built for each request; `defaults`: what every cookie set through this jar gets unless `set` says otherwise ({@link CookieDefaults}). */
  constructor(header: string | null, defaults: CookieDefaults = {}) {
    this.#incoming = parseCookies(header);
    this.#defaults = defaults;
  }

  get(name: string): string | undefined {
    return this.#incoming.get(name);
  }

  has(name: string): boolean {
    return this.#incoming.has(name);
  }

  all(): Record<string, string> {
    return Object.fromEntries(this.#incoming);
  }

  /**
   * Queues a cookie ([cookies](docs/responses.md#cookies)). Throws a TypeError for an invalid name, a value that is not a string or has half of a
   * surrogate pair, a `path` or `domain` with `;`, a control character or a character above U+00FF, an unknown `sameSite`, a `maxAge` that is not a span of time, an `expires` that is not a valid date, `SameSite=None` without
   * `secure`, and a `__Secure-` or `__Host-` name that does not meet its prefix's rules.
   */
  set(name: string, value: string, given?: CookieOptions): void {
    // Checked now, where the mistake is made — the header is built once, when the response goes out. What is queued is the copy
    // `checkCookie` returns, so the caller's objects no longer matter. The jar's defaults (`secure` from the session's config) apply
    // unless the call says otherwise — also `secure: false`.
    const options = checkCookie(name, given, this.#defaults);
    checkValue(name, value);
    if (this.#permit && !this.#permit(`cookies.set('${name}')`)) return;
    this.#queued.set(name, { value, options });
  }

  /**
   * @internal The kernel's.
   * Locks the jar for a read-only request (an island): every `set`/`delete` asks `permit` first, which throws or
   * answers false — then nothing is queued.
   */
  lock(permit: (what: string) => boolean): void {
    this.#permit = permit;
  }

  /** Expires the cookie in the browser. Pass the same `path`/`domain` it was set with. */
  delete(name: string, options: Pick<CookieOptions, 'path' | 'domain'> = {}): void {
    this.set(name, '', { path: options.path, domain: options.domain, maxAge: 0, expires: new Date(0) });
  }

  /**
   * @internal `EncryptCookies` installs one.
   * Installs a codec: decodes the incoming cookies now (so `get` stays synchronous)
   * and encodes queued ones when they are written. Cookies it cannot decode vanish.
   */
  async useCodec(codec: CookieCodec): Promise<void> {
    const decoded = new Map<string, string>();
    for (const [name, value] of this.#incoming) {
      const plain = await codec.decode(name, value);
      if (plain !== undefined) decoded.set(name, plain);
    }
    this.#incoming = decoded;
    this.#codec = codec;
  }

  readonly #stale = new Set<string>();
  #private = false;

  /** @internal The cookie codec saw this cookie sealed with a previous key: whoever owns it sends it again under the current one. */
  markStale(name: string): void {
    this.#stale.add(name);
  }

  /** @internal Whether the incoming cookie `name` was sealed with a previous key. */
  isStale(name: string): boolean {
    return this.#stale.has(name);
  }

  /** @internal The answer belongs to a session: the kernel keeps it from shared caches, whatever a middleware set. */
  markPrivate(): void {
    this.#private = true;
  }

  /** @internal */
  get markedPrivate(): boolean {
    return this.#private;
  }

  /** @internal The response writes these. `Set-Cookie` values queued so far, one per cookie name (the last `set` wins). Deletions are not encoded. */
  async queued(): Promise<string[]> {
    const headers: string[] = [];
    for (const [name, { value, options }] of this.#queued) {
      const encoded = this.#codec && value !== '' ? await this.#codec.encode(name, value) : value;
      headers.push(serializeCookie(name, encoded, options));
    }
    return headers;
  }
}

/** Adds the jar's queued cookies to a response — in place when the request owns it, else to a copy ({@link editableResponse}). */
export async function withQueuedCookies(response: Response, cookies: CookieJar): Promise<Response> {
  const queued = await cookies.queued();
  if (queued.length === 0) return response;
  const editable = editableResponse(response);
  for (const cookie of queued) editable.headers.append('set-cookie', cookie);
  return editable;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * `text` without the SP (0x20) and HTAB (0x09) at either end. A loop, not `/^[ \t]+|[ \t]+$/g`: the regex retries `[ \t]+$`
 * at every blank of a run that does not end the text, quadratic in a header any client sends.
 */
function trimSpaceAndTab(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpaceOrTab(text.charCodeAt(start))) start++;
  while (end > start && isSpaceOrTab(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

function isSpaceOrTab(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

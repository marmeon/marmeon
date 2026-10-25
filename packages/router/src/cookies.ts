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
 * What every cookie of a request gets unless its `set` says otherwise: the kernel takes them
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
    const name = part.slice(0, index).replace(/^[ \t]+|[ \t]+$/g, '');
    if (!COOKIE_NAME.test(name) || cookies.has(name)) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1);
    cookies.set(name, safeDecode(value));
  }
  return cookies;
}

/** Builds a `Set-Cookie` header value. The value is URI-encoded, so any string is safe. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  checkCookie(name, options);
  const { path = '/', domain, maxAge, expires, secure = false, httpOnly = true, sameSite = 'lax' } = options;

  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (domain) parts.push(`Domain=${domain}`);
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(durationToSeconds(maxAge))}`);
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

/** Throws for what `serializeCookie` refuses — an invalid name, `SameSite=None` without `secure` — without building the header. */
function checkCookie(name: string, options: CookieOptions | undefined): void {
  if (!COOKIE_NAME.test(name)) throw new TypeError(`Invalid cookie name "${name}".`);
  if (options?.sameSite === 'none' && !options.secure) throw new TypeError(`Cookie "${name}": SameSite=None requires secure: true.`);
  // A browser refuses a `__Host-` cookie that is not Secure, has a Domain or a Path other than `/`; refusing it here too
  // means the prefix is never set on a cookie that does not earn it.
  const lower = name.toLowerCase();
  if (lower.startsWith(SECURE_PREFIX) && !options?.secure) throw new TypeError(`Cookie "${name}": the __Secure- prefix requires secure: true.`);
  if (lower.startsWith(HOST_PREFIX) && (!options?.secure || options.domain || (options.path ?? '/') !== '/')) {
    throw new TypeError(`Cookie "${name}": the __Host- prefix requires secure: true, path "/" and no domain.`);
  }
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

  /** `defaults`: what every cookie set through this jar gets unless `set` says otherwise ({@link CookieDefaults}). */
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

  set(name: string, value: string, given?: CookieOptions): void {
    // The jar's defaults (`secure` from the session's config) unless the call says otherwise — also `secure: false`.
    const options = this.#defaults.secure && given?.secure === undefined ? { ...given, secure: true } : given;
    checkCookie(name, options); // now, where the mistake is made — the header is built once, when the response goes out
    if (this.#permit && !this.#permit(`cookies.set('${name}')`)) return;
    this.#queued.set(name, { value, options });
  }

  /**
   * Locks the jar for a read-only request (an island): every `set`/`delete` asks `permit` first, which throws or
   * answers false — then nothing is queued.
   */
  lock(permit: (what: string) => boolean): void {
    this.#permit = permit;
  }

  /** Expires the cookie in the browser. Pass the same `path`/`domain` it was set with. */
  delete(name: string, options: Pick<CookieOptions, 'path' | 'domain'> = {}): void {
    this.set(name, '', { ...options, maxAge: 0, expires: new Date(0) });
  }

  /**
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

  /** `Set-Cookie` values queued so far, one per cookie name (the last `set` wins). Deletions are not encoded. */
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

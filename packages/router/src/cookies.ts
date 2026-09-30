export interface CookieOptions {
  /** Lifetime in seconds. Without `maxAge` and `expires`, the cookie ends with the browser session. */
  maxAge?: number;
  expires?: Date;
  /** Defaults to `/`. */
  path?: string;
  domain?: string;
  /** Defaults to `false`. */
  secure?: boolean;
  /** Defaults to `true` — scripts cannot read the cookie (like Laravel). */
  httpOnly?: boolean;
  /** Defaults to `lax`. `none` requires `secure`. */
  sameSite?: 'lax' | 'strict' | 'none';
}

/** RFC 6265 `token`: what a cookie name may consist of. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** `a=1; b=hello%20world` → `{ a: '1', b: 'hello world' }`. The first occurrence of a name wins. */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (name === '' || cookies.has(name)) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1);
    cookies.set(name, safeDecode(value));
  }
  return cookies;
}

/** Builds a `Set-Cookie` header value. The value is URI-encoded, so any string is safe. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!COOKIE_NAME.test(name)) throw new TypeError(`Invalid cookie name "${name}".`);
  const { path = '/', domain, maxAge, expires, secure = false, httpOnly = true, sameSite = 'lax' } = options;
  if (sameSite === 'none' && !secure) throw new TypeError(`Cookie "${name}": SameSite=None requires secure: true.`);

  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (domain) parts.push(`Domain=${domain}`);
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (expires) parts.push(`Expires=${expires.toUTCString()}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  parts.push(`SameSite=${sameSite[0]!.toUpperCase()}${sameSite.slice(1)}`);
  return parts.join('; ');
}

/**
 * The cookies of one request: reads what the client sent, queues what the
 * response should set (Laravel's `Cookie::queue`). Queued cookies are added to
 * whatever response the request ends with — a view, a redirect or an error page.
 *
 * `get` only sees cookies the client sent, not ones queued in this request.
 */
export class CookieJar {
  readonly #incoming: ReadonlyMap<string, string>;
  readonly #queued = new Map<string, string>();

  constructor(header: string | null) {
    this.#incoming = parseCookies(header);
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

  set(name: string, value: string, options?: CookieOptions): void {
    this.#queued.set(name, serializeCookie(name, value, options));
  }

  /** Expires the cookie in the browser. Pass the same `path`/`domain` it was set with. */
  delete(name: string, options: Pick<CookieOptions, 'path' | 'domain'> = {}): void {
    this.set(name, '', { ...options, maxAge: 0, expires: new Date(0) });
  }

  /** `Set-Cookie` values queued so far, one per cookie name (the last `set` wins). */
  queued(): string[] {
    return [...this.#queued.values()];
  }
}

/** Adds the jar's queued cookies to a response (copying it, since some responses have immutable headers). */
export function withQueuedCookies(response: Response, cookies: CookieJar): Response {
  const queued = cookies.queued();
  if (queued.length === 0) return response;
  const copy = new Response(response.body, response);
  for (const cookie of queued) copy.headers.append('set-cookie', cookie);
  return copy;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

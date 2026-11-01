import { isIP } from 'node:net';

interface KeptCookie {
  readonly name: string;
  /** Exactly as the server sent it (encrypted, URL-encoded): it goes back the same way. */
  readonly value: string;
  /** The host that set a host-only cookie, or the `Domain` attribute. */
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  /** Milliseconds on the app's clock; none for a cookie that lives as long as the "browser". */
  readonly expires: number | undefined;
  readonly secure: boolean;
  /** Orders cookies of the same path length, oldest first. */
  readonly created: number;
}

/**
 * The cookies a test view holds between its requests, kept the way a browser keeps them (RFC 6265): by name, domain and path;
 * sent only to a host, a path and a scheme they belong to; gone once `Max-Age` or `Expires` is over on the app's clock.
 * Left out: the public-suffix list, `SameSite` (every request is same-site) and `HttpOnly` (nothing runs scripts here).
 *
 * @internal
 */
export class KeptCookies {
  /** The session holders (`actingAs`, `withSession`) whose session this jar already carries. */
  readonly sessions = new WeakSet<object>();
  readonly #cookies = new Map<string, KeptCookie>();
  #created = 0;

  /** Takes in one `Set-Cookie` header of a response to `url`. A cookie a browser would refuse is dropped. */
  receive(header: string, url: URL, now: number): void {
    const [pair, ...rest] = header.split(';');
    const index = pair!.indexOf('=');
    if (index < 0) return;
    const name = pair!.slice(0, index).trim();
    if (name === '') return;
    const attributes = new Map<string, string>();
    for (const attribute of rest) {
      const at = attribute.indexOf('=');
      const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
      const value = at < 0 ? '' : attribute.slice(at + 1).trim();
      // An attribute that does not parse is ignored, so an earlier valid one stands.
      if (key === 'max-age' && !/^-?\d+$/.test(value)) continue;
      if (key === 'expires' && !isCookieDate(value)) continue;
      attributes.set(key, value);
    }

    const host = url.hostname.toLowerCase();
    const secure = attributes.has('secure');
    const declared = attributes.get('domain')?.replace(/^\./, '').toLowerCase();
    const domain = declared === undefined || declared === '' ? undefined : declared;
    if (domain !== undefined && !acceptsDomain(domain, host)) return;
    const given = attributes.get('path');
    const path = given !== undefined && given.startsWith('/') ? given : defaultPath(url.pathname);
    if (secure && !isSecureOrigin(url)) return;
    const lower = name.toLowerCase();
    if (lower.startsWith('__secure-') && !secure) return;
    if (lower.startsWith('__host-') && (!secure || domain !== undefined || attributes.get('path') !== '/')) return;

    const cookie: KeptCookie = {
      name,
      value: pair!.slice(index + 1).trim(),
      domain: domain ?? host,
      hostOnly: domain === undefined,
      path,
      expires: expiry(attributes, now),
      secure,
      created: this.#created++,
    };
    const key = keyOf(cookie);
    const before = this.#cookies.get(key);
    // An expired cookie deletes the one it names.
    if (cookie.expires !== undefined && cookie.expires <= now) this.#cookies.delete(key);
    else this.#cookies.set(key, before ? { ...cookie, created: before.created } : cookie);
  }

  /** Holds a cookie for the host of `url` that no response set, such as the session `actingAs()` starts. */
  set(name: string, value: string, url: URL): void {
    const cookie: KeptCookie = { name, value, domain: url.hostname.toLowerCase(), hostOnly: true, path: '/', expires: undefined, secure: false, created: this.#created++ };
    this.#cookies.set(keyOf(cookie), cookie);
  }

  /** The cookies a browser would send with a request to `url`, longest path first, then oldest first. */
  matching(url: URL, now: number): { name: string; value: string }[] {
    const host = url.hostname.toLowerCase();
    const sent: KeptCookie[] = [];
    for (const [key, cookie] of this.#cookies) {
      if (cookie.expires !== undefined && cookie.expires <= now) {
        this.#cookies.delete(key);
        continue;
      }
      if (cookie.hostOnly ? cookie.domain !== host : !domainMatches(host, cookie.domain)) continue;
      if (!pathMatches(url.pathname, cookie.path)) continue;
      if (cookie.secure && !isSecureOrigin(url)) continue;
      sent.push(cookie);
    }
    return sent.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  }
}

/** `https:`, and the loopback hosts browsers also trust over `http:`. */
function isSecureOrigin(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  const host = url.hostname.toLowerCase();
  return url.protocol === 'http:' && (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]');
}

const keyOf = (cookie: KeptCookie): string => `${cookie.domain}\n${cookie.path}\n${cookie.name}`;

/** Only a date with a time of day and a month name counts (RFC 6265 5.1.1): `Date.parse` alone takes `1` for a year. */
function isCookieDate(value: string): boolean {
  return /\d{1,2}:\d{2}:\d{2}/.test(value) && /(?:^|[^a-z])(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(value) && !Number.isNaN(Date.parse(value));
}

/** `Max-Age` wins over `Expires`; a value that does not parse counts as none. */
function expiry(attributes: ReadonlyMap<string, string>, now: number): number | undefined {
  const maxAge = attributes.get('max-age');
  if (maxAge !== undefined) return now + Number(maxAge) * 1000;
  const expires = attributes.get('expires');
  if (expires === undefined) return undefined;
  return Date.parse(expires);
}

/** A `Domain` is taken only for the host itself or a parent of it, and never a bare top-level name. */
function acceptsDomain(domain: string, host: string): boolean {
  if (domain === host) return true;
  return domain.includes('.') && domainMatches(host, domain);
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || (isIP(host) === 0 && host.endsWith(`.${domain}`));
}

/** RFC 6265 5.1.4: the directory of the request path. */
function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const last = pathname.lastIndexOf('/');
  return last === 0 ? '/' : pathname.slice(0, last);
}

function pathMatches(pathname: string, path: string): boolean {
  if (pathname === path) return true;
  if (!pathname.startsWith(path)) return false;
  return path.endsWith('/') || pathname[path.length] === '/';
}

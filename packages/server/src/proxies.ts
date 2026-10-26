import { BlockList, isIP } from 'node:net';

/**
 * Whether an entry of `SERVER_TRUSTED_PROXIES` is one: `*`, an address (`127.0.0.1`, `::1`) or a range (`10.0.0.0/8`, `fd00::/8`).
 * The config refuses anything else at boot — a typo must not silently trust nobody (or everybody): a range of every address
 * (`0.0.0.0/0`, `::/0`, or an IPv6 range holding all of IPv4 as `::ffff:0.0.0.0/96`) is none either — `*` says that.
 */
export function isProxyEntry(entry: string): boolean {
  if (entry === '*') return true;
  const [address, prefix, extra] = entry.split('/');
  const family = isIP(address ?? '');
  if (family === 0 || extra !== undefined) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  if (Number(prefix) > (family === 4 ? 32 : 128)) return false;
  return !coversEveryPeer(address!, Number(prefix), family);
}

/** Whether a range holds every IPv4 peer (an IPv6 one: every IPv4-mapped address too) — what `*` is for. */
function coversEveryPeer(address: string, prefix: number, family: number): boolean {
  if (prefix === 0) return true;
  if (family === 4) return false;
  const list = new BlockList();
  list.addSubnet(address, prefix, 'ipv6');
  return list.check('::ffff:0.0.0.0', 'ipv6') && list.check('::ffff:255.255.255.255', 'ipv6');
}

/**
 * The check behind `SERVER_TRUSTED_PROXIES`: whether a peer is one of the app's proxies — by address or range (CIDR), IPv4
 * and IPv6, an IPv4-mapped IPv6 peer (`::ffff:10.0.0.1`) as its IPv4 address. Empty: nobody (the default — `X-Forwarded-*`
 * are ignored); `*`: whoever connects — the direct peer is the proxy; the client's address is then the entry it added
 * (`clientIp` with `['*']`), never one before it.
 */
export function proxyMatcher(entries: readonly string[]): (address: string) => boolean {
  if (entries.includes('*')) return () => true;
  if (entries.length === 0) return () => false;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split('/') as [string, string | undefined];
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return (address) => {
    const plain = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
    const family = isIP(plain);
    return family !== 0 && list.check(plain, family === 4 ? 'ipv4' : 'ipv6');
  };
}

/** A host as `X-Forwarded-Host` may name it: a name or an address, with an optional port — nothing else reaches the URL. */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** The value the nearest proxy added to a `X-Forwarded-*` list (the right-most one), trimmed — or none. */
function nearest(value: string | null): string | undefined {
  if (value === null) return undefined;
  const at = value.lastIndexOf(',');
  return (at === -1 ? value : value.slice(at + 1)).trim() || undefined;
}

/**
 * The request as the client sent it to the app's proxy: from a trusted peer, `X-Forwarded-Proto` (`http`/`https`) and
 * `X-Forwarded-Host` replace the URL's protocol and host — so the CSRF origin check, an island's origin, the asset version's
 * reload URL and `ctx.request.url` see `https://example.com/…`, not the proxy's `http://10.0.0.5:3000/…`. From anybody else
 * the headers are ignored; a value that is no protocol or host is ignored too. Of a list (`https, http`), the right-most value
 * counts: the one the nearest proxy — the trusted one — added. `Forwarded` (RFC 7239) is not read.
 *
 * The same request when nothing changes (no headers, an untrusted peer): no copy on the common path.
 */
export function forwardedRequest(request: Request, remote: string | undefined, trusts: (address: string) => boolean): Request {
  if (remote === undefined || !trusts(remote)) return request;
  const proto = nearest(request.headers.get('x-forwarded-proto'))?.toLowerCase();
  const host = nearest(request.headers.get('x-forwarded-host'));
  const url = new URL(request.url);
  let changed = false;
  if ((proto === 'http' || proto === 'https') && url.protocol !== `${proto}:`) {
    url.protocol = proto;
    changed = true;
  }
  if (host !== undefined && HOST.test(host) && url.host !== host.toLowerCase()) {
    // Name and port together: the `host` setter alone would keep the proxy-side port (`:3000`) when the value names none.
    const named = new URL(`http://${host}`);
    url.hostname = named.hostname;
    url.port = named.port;
    changed = true;
  }
  if (!changed) return request;
  const hasBody = request.body !== null && request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
  } as RequestInit);
}

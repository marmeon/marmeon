/**
 * The guard of every development route (E200) — the devtools (`/_marmeon/devtools`), the mail previews (`/_marmeon/mail`) and any
 * later one. Such a route exists only with `NODE_ENV=development` (E115); this decides **who** it answers:
 *
 * ```ts
 * import { devHosts, devOnly } from '@marmeon/core/dev';
 *
 * const hosts = devHosts(env.APP_URL); // localhost, 127.0.0.1, [::1] and APP_URL's host
 * Route.get('/_marmeon/mail', devOnly(hosts, () => previews.index()));
 * ```
 *
 * **Why a host check:** DNS rebinding. A page on `evil.example` whose name the attacker then points at 127.0.0.1 reaches the
 * developer's server with `Host: evil.example` — and reads every answer as same-origin. Vite refuses unknown hosts itself
 * (`server.allowedHosts`), but only for its own server and **not under HTTPS** (Vite skips the check there), and an app's own
 * routes must not rely on what runs in front of them.
 */

/** The loopback names — development routes always answer them. */
export const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** The host names development routes answer: the loopback ones and the host of `appUrl` (lower case, no port). */
export function devHosts(appUrl: string | undefined): ReadonlySet<string> {
  const hosts = new Set(LOOPBACK_HOSTS);
  if (appUrl) {
    try {
      hosts.add(new URL(appUrl).hostname.toLowerCase());
    } catch {
      // Not a URL: only the loopback names (the app's own config reports a broken APP_URL).
    }
  }
  return hosts;
}

/**
 * Whether a request is for one of `hosts` — its `Host` header (or, without one, its URL's host), port aside. A name that only
 * starts or ends like an allowed one (`localhost.evil.example`), userinfo (`localhost@evil.example`), a path smuggled into
 * `Host` and an empty `Host` never match.
 */
export function hostAllowed(request: Request, hosts: ReadonlySet<string>): boolean {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  // `http://a@evil.example` parses as evil.example; a path or query smuggled into Host never matches a bare name.
  return host.length <= 255 && !/[/?#@\\]/.test(host) && hosts.has(hostname);
}

/** What every answer of a development route carries — pages, JSON, streams, error pages and the 403 alike. */
const DEV_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-robots-tag': 'noindex',
};

/**
 * A development route's answer as it leaves: never cached, never sniffed, never framed by another origin (its own CSP, or
 * `frame-ancestors 'self'` when it has none), never shared with another origin (every CORS header is taken out).
 */
export function devSecured(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(DEV_HEADERS)) out.headers.set(name, value);
  if (!out.headers.has('content-security-policy')) out.headers.set('content-security-policy', "frame-ancestors 'self'");
  for (const name of [...out.headers.keys()]) if (name.startsWith('access-control-')) out.headers.delete(name);
  return out;
}

/** The answer for a request from a host development routes do not answer. */
export function forbiddenDevHost(): Response {
  return devSecured(
    new Response(
      'Development routes answer only on localhost, 127.0.0.1, [::1] and the host of APP_URL (DNS rebinding). Open this page through one of them.\n',
      { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    ),
  );
}

/**
 * Wraps a development route's handler — or a middleware's `handle` (its `next` comes through): a request for a host outside
 * `hosts` gets 403 and the handler never runs; every answer gets {@link devSecured}'s headers (`no-store`, CORP/COOP
 * `same-origin`, `nosniff`, no CORS).
 *
 * ```ts
 * Route.get('/_marmeon/mail', devOnly(hosts, () => previews.index()));
 * defineMiddleware('DevtoolsGuard', devOnly(hosts, (_ctx, next) => next()));
 * ```
 */
export function devOnly<TArgs extends readonly [{ readonly request: Request }, ...unknown[]]>(
  hosts: ReadonlySet<string>,
  handler: (...args: TArgs) => Response | Promise<Response>,
): (...args: TArgs) => Promise<Response> {
  return async (...args) => (hostAllowed(args[0].request, hosts) ? devSecured(await handler(...args)) : forbiddenDevHost());
}

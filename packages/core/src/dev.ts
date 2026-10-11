/**
 * The guard of every development route (the devtools, the mail previews, an app's own): outside `NODE_ENV=development` (and
 * `test`) a 404, and only the loopback names and `APP_URL`'s host are answered. See docs/routing.md#development-only-routes.
 *
 * **Why a host check:** DNS rebinding — a page on `evil.example` re-pointed at 127.0.0.1 reaches the developer's server with
 * `Host: evil.example` and reads every answer as same-origin. Vite's `server.allowedHosts` covers only its own server and is
 * skipped under HTTPS, and an app's routes must not rely on what runs in front of them.
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

/** Whether development routes answer at all: `NODE_ENV` is `development` (or `test`) — asked positively, per request. */
export function devEnvironment(env: { readonly NODE_ENV?: string | undefined } = process.env): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

/** The answer of a development route outside development: as if there were none. */
export function notInDevelopment(): Response {
  return devSecured(new Response('Not Found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
}

/**
 * Wraps a development route's handler — or a middleware's `handle` (its `next` comes through): outside development (`NODE_ENV`
 * neither `development` nor `test` — production, none, a value the start check let through) a 404, fail-closed; a request for a host outside `hosts`
 * gets 403; in both cases the handler never runs. Every answer gets {@link devSecured}'s headers (`no-store`, CORP/COOP
 * `same-origin`, `nosniff`, no CORS).
 *
 * ```ts
 * Route.get('/_playground', devOnly(hosts, () => previews.index()));
 * defineMiddleware('DevtoolsGuard', devOnly(hosts, (_ctx, next) => next()));
 * ```
 */
export function devOnly<TArgs extends readonly [{ readonly request: Request }, ...unknown[]]>(
  hosts: ReadonlySet<string>,
  handler: (...args: TArgs) => Response | Promise<Response>,
): (...args: TArgs) => Promise<Response> {
  return async (...args) => {
    if (!devEnvironment()) return notInDevelopment();
    return hostAllowed(args[0].request, hosts) ? devSecured(await handler(...args)) : forbiddenDevHost();
  };
}

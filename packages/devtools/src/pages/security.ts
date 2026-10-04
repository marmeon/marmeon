import { PAGE_CSP } from './assets.ts';

/**
 * Whether a request is for one of `hosts` — its `Host` header (or, without one, its URL's host), port aside. Against DNS
 * rebinding: a page on `evil.example` whose name was pointed at 127.0.0.1 reaches the dev server with `Host: evil.example`
 * and would read the devtools as same-origin; it gets 403 instead.
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

/** What every answer of the devtools carries — pages, JSON, the stream, error pages alike. */
const ALWAYS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-robots-tag': 'noindex',
};

/**
 * The devtools' answer as it leaves: never cached, never framed by another origin (`frame-ancestors 'self'` — the pages'
 * own CSP, or that alone on an error page the kernel rendered), never shared with another origin (no CORS header is ever set).
 */
export function secured(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(ALWAYS)) out.headers.set(name, value);
  if (!out.headers.has('content-security-policy')) out.headers.set('content-security-policy', "frame-ancestors 'self'");
  for (const name of [...out.headers.keys()]) if (name.startsWith('access-control-')) out.headers.delete(name);
  return out;
}

/** 403 for a request from a host the devtools do not answer. */
export function forbiddenHost(): Response {
  return new Response('The devtools answer only on localhost, 127.0.0.1, [::1] and the host of APP_URL.\n', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** An HTML page of the devtools, with its CSP. */
export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP } });
}

/** JSON of the API. */
export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

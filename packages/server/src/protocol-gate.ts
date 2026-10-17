import { answersWithData, isProtocolRequest, LOCATION_HEADER, PAGE_HEADER, REGION_HEADER, RELOAD_HEADER, SUPPORTED_PROTOCOLS } from '@marmeon/http/internal';

/**
 * The answer to a request of the page protocol that names a version this server does not speak — or none: `409` with the
 * address to load fully (`x-marmeon-location`) and `x-marmeon-reload: version`. Undefined for any other request, and for one
 * of a supported version.
 *
 * It runs before routing, so no middleware, CSRF check, session or controller sees such a request, whatever its method: an
 * open tab of another build sends forms, actions and validations in a shape this server may read differently. The answer
 * has no side effect (no cookie, no session) and is never cached. A GET of a page is loaded again from its own URL;
 * anything else (a write, a GET action, an island) from the page it came from (`Referer`, when it is this site's), else the start page.
 */
export function protocolGate(request: Request, supported: ReadonlySet<string> = SUPPORTED_PROTOCOLS): Response | undefined {
  if (!isProtocolRequest(request)) return undefined;
  const version = request.headers.get(PAGE_HEADER);
  if (version !== null && supported.has(version)) return undefined;
  return new Response(null, {
    status: 409,
    headers: {
      [LOCATION_HEADER]: isPageLoad(request) ? request.url : (sameSiteReferer(request) ?? '/'),
      [RELOAD_HEADER]: 'version',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      vary: PAGE_HEADER,
    },
  });
}

/** A GET of a page: its URL is a document to load. Not an action, a validation, an upload or an island — those are data endpoints. */
function isPageLoad(request: Request): boolean {
  return request.method === 'GET' && !answersWithData(request.headers) && request.headers.get(REGION_HEADER) !== 'island';
}

/** The page a write came from, when `Referer` names one of this site — a foreign address is never the place to load. */
function sameSiteReferer(request: Request): string | undefined {
  const referer = request.headers.get('referer');
  if (referer === null) return undefined;
  try {
    const url = new URL(referer);
    return url.origin === new URL(request.url).origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}
